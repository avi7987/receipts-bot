// =====================================================================
//  colleague-admin.js — הוספה וניהול של עמיתים בשירות הדרייב.
//
//  add       --name "דני כהן" --folder <קישור לתיקייה>   (המפתח ב-stdin)
//  list
//  bookmarklet <id>
//  pause <id> | resume <id>
//  remove <id>
//
//  המפתח נקרא מהקלט ולא מהפקודה, כדי שלא יישאר בהיסטוריית המסוף
//  ולא יופיע ברשימת התהליכים של השרת.
//
//  ההוספה בודקת הכול לפני שהיא שומרת: שהתיקייה משותפת, שיש בה
//  גיליון אחד שאפשר לערוך, שהמפתח עובד באמת, ושהוא לא המפתח שלך.
//  עדיף שהבדיקה תיכשל עכשיו, מול מי שמוסיף, מאשר שעמית יגלה אחרי
//  יומיים שאף קבלה לא נקלטה.
// =====================================================================
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import * as C from './colleagues.js';
import { folderInfo, spreadsheetsIn } from './drive.js';
import { runWorker } from './drive-runner.js';
import { buildBookmarklet } from './bookmarklet.js';

const PUBLIC = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : null;
};
const die = (msg) => { console.error(`❌ ${msg}`); process.exit(1); };

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

// ── בדיקת מפתח AI בקריאה אמיתית ─────────────────────────────────────
async function checkKey(key) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ contents: [{ parts: [{ text: 'ok' }] }], generationConfig: { maxOutputTokens: 256 } }),
  });
  if (res.ok) return { ok: true };
  const text = (await res.text()).slice(0, 300);
  // מכסה שנגמרה פירושה שהמפתח עצמו תקין
  if (res.status === 429) return { ok: true, warning: 'המפתח תקין, אבל המכסה היומית שלו נגמרה כרגע' };
  if ([400, 401, 403].includes(res.status)) return { ok: false, error: 'המפתח לא תקין או לא פעיל' };
  if (res.status === 404) return { ok: false, error: `המודל ${MODEL} לא זמין למפתח הזה` };
  return { ok: false, error: `Gemini ${res.status}: ${text}` };
}

function writeBookmarklet(c) {
  const { text, version } = buildBookmarklet({ api: PUBLIC, key: C.pendingKeyOf(c.secret) });
  const dir = path.join(C.DATA_DIR, 'bookmarklets');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${c.id}.txt`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { file, version, text };
}

const sheetUrl = (id) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

// ── add ─────────────────────────────────────────────────────────────
async function add() {
  const name = (flag('name') || '').trim();
  const folderId = C.folderIdFrom(flag('folder'));
  if (!name) die('חסר --name');
  if (!folderId) die('חסר --folder (קישור לתיקייה בדרייב)');
  if (!PUBLIC.startsWith('https://')) die('PUBLIC_BASE_URL חסר או לא https');

  const key = (flag('key') || (await readStdin())).split(/\s+/)[0] || '';
  if (!key) die('חסר מפתח AI (העבר ב-stdin)');

  const all = C.list();
  if (all.some((c) => c.folderId === folderId)) die('התיקייה הזו כבר רשומה לעמית אחר');

  // 1. התיקייה
  process.stdout.write('1/4 תיקייה... ');
  let folder;
  try {
    folder = await folderInfo(folderId);
  } catch (e) {
    const why = {
      'folder-not-shared': `התיקייה לא משותפת עם ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL}`,
      'not-a-folder': 'הקישור אינו לתיקייה',
      'folder-not-readable': 'התיקייה משותפת אבל בלי הרשאת קריאה',
    }[e.message] || e.message;
    die(why);
  }
  console.log(`✅ ${folder.name}`);

  // 2. הגיליון שבתוך התיקייה
  process.stdout.write('2/4 גיליון... ');
  const sheets = await spreadsheetsIn(folderId);
  let sheet;
  const wanted = flag('sheet');
  if (wanted) sheet = sheets.find((s) => s.id === wanted);
  else if (sheets.length === 1) [sheet] = sheets;
  if (!sheet) {
    if (!sheets.length) die('אין גיליון בתוך התיקייה. צריך ליצור בה Google Sheets ריק');
    die(`יש ${sheets.length} גיליונות בתיקייה — בחר עם --sheet <id>:\n${sheets.map((s) => `   ${s.id}  ${s.name}`).join('\n')}`);
  }
  if (sheet.capabilities?.canEdit === false) die('לגיליון יש הרשאת צפייה בלבד — השיתוף צריך להיות "עורך"');
  console.log(`✅ ${sheet.name}`);

  // 3. המפתח
  process.stdout.write('3/4 מפתח AI... ');
  const hash = C.keyHash(key);
  if (process.env.OWNER_KEY_HASH && hash === process.env.OWNER_KEY_HASH) {
    die('זה המפתח שלך. לכל עמית צריך מפתח מחשבון הגוגל שלו — אחרת הקבלות שלו נספרות על המכסה שלך');
  }
  const twin = all.find((c) => C.keyHash(c.geminiKey) === hash);
  if (twin) die(`המפתח כבר בשימוש אצל ${twin.name} — שני אנשים על מפתח אחד חולקים מכסה`);
  const check = await checkKey(key);
  if (!check.ok) die(check.error);
  console.log(check.warning ? `⚠️  ${check.warning}` : '✅ עובד');

  // 4. שמירה והכנת הגיליון
  process.stdout.write('4/4 הכנת הגיליון... ');
  const c = {
    id: C.newId(),
    name,
    folderId,
    folderName: folder.name,
    sheetId: sheet.id,
    sheetName: sheet.name,
    geminiKey: key,
    secret: C.newSecret(),
    active: true,
    createdAt: new Date().toISOString(),
  };
  C.save([...all, c]);

  const r = await runWorker(c, 'setup', { timeoutMs: 120e3 });
  if (!r.ok) {
    // לא משאירים רשומה חצי־עובדת
    C.save(C.list().filter((x) => x.id !== c.id));
    die(`הכנת הגיליון נכשלה: ${r.error}`);
  }
  console.log('✅');

  const bm = writeBookmarklet(c);
  console.log(`\n🎉 ${name} נוסף/ה (${c.id})`);
  console.log(`   גיליון:  ${sheetUrl(c.sheetId)}`);
  console.log(`   סימנייה: ${bm.file} (v${bm.version})`);
  console.log('   הקבלות שכבר בתיקייה ייקלטו בסבב הקרוב.');
  if (rest.includes('--print-bookmarklet')) console.log(`\n@@BOOKMARKLET ${bm.text}`);
}

// ── שאר הפקודות ─────────────────────────────────────────────────────
function need(id) {
  const c = C.byId(id);
  if (!c) die(`אין עמית ${id}`);
  return c;
}

function setActive(id, active) {
  need(id);
  C.save(C.list().map((c) => (c.id === id ? { ...c, active } : c)));
  console.log(`✅ ${id} ${active ? 'פעיל' : 'מושהה'}`);
}

switch (cmd) {
  case 'add':
    await add();
    break;
  case 'list': {
    const all = C.list();
    if (!all.length) console.log('אין עמיתים רשומים.');
    for (const c of all) {
      console.log(`${c.active === false ? '⏸' : '▶'} ${c.id}  ${c.name}  ·  📁 ${c.folderName}  ·  ${sheetUrl(c.sheetId)}`);
    }
    break;
  }
  case 'bookmarklet': {
    const bm = writeBookmarklet(need(rest[0]));
    console.log(`✅ ${bm.file} (v${bm.version})`);
    if (rest.includes('--print')) console.log(`\n@@BOOKMARKLET ${bm.text}`);
    break;
  }
  case 'pause': setActive(rest[0], false); break;
  case 'resume': setActive(rest[0], true); break;
  case 'remove': {
    const c = need(rest[0]);
    C.save(C.list().filter((x) => x.id !== c.id));
    fs.rmSync(C.tenantDir(c.id), { recursive: true, force: true });
    fs.rmSync(path.join(C.DATA_DIR, 'bookmarklets', `${c.id}.txt`), { force: true });
    console.log(`✅ ${c.name} הוסר/ה. הגיליון והתיקייה שלו/ה לא נגעו.`);
    break;
  }
  default:
    console.log('שימוש: add --name <שם> --folder <קישור>  |  list  |  bookmarklet <id>  |  pause <id>  |  resume <id>  |  remove <id>');
    process.exit(cmd ? 1 : 0);
}
