// =====================================================================
//  colleague-admin.js — ניהול עמיתים בשירות הדרייב.
//
//  add       --name "דני כהן" --folder <קישור לתיקייה>   (המפתח ב-stdin)
//  list
//  bookmarklet <id>
//  pause <id> | resume <id>
//  remove <id>
//
//  ברוב המקרים לא צריך את add: עמיתים נרשמים לבד בדף /join. הפקודה
//  נשארת למקרה שמישהו לא מסתדר, והיא מריצה בדיוק את אותן בדיקות
//  (onboard.js) — אין מסלול "קל יותר" שמדלג על משהו.
//
//  המפתח נקרא מהקלט ולא מהפקודה, כדי שלא יישאר בהיסטוריית המסוף
//  ולא יופיע ברשימת התהליכים של השרת.
// =====================================================================
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import * as C from './colleagues.js';
import { register } from './onboard.js';
import { buildBookmarklet } from './bookmarklet.js';

const PUBLIC = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

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
  const key = flag('key') || (await readStdin());
  const labels = { folder: 'תיקייה', sheet: 'גיליון', key: 'מפתח AI', setup: 'הכנת הגיליון' };

  let r;
  try {
    r = await register({
      name: flag('name'),
      folder: flag('folder'),
      key,
      onStep: (s) => console.log(`   · ${labels[s] || s}...`),
    });
  } catch (e) {
    die(e.message);
  }

  const bm = writeBookmarklet(r.colleague);
  const verb = { created: 'נוסף/ה', recovered: 'כבר רשום/ה — הסימנייה נבנתה מחדש', updated: 'המפתח הוחלף' }[r.status];
  console.log(`\n🎉 ${r.colleague.name} ${verb} (${r.colleague.id})`);
  if (r.warning) console.log(`   ⚠️  ${r.warning}`);
  console.log(`   גיליון:  ${r.sheetUrl}`);
  console.log(`   סימנייה: ${bm.file} (v${bm.version})`);
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
      console.log(`${c.active === false ? '⏸' : '▶'} ${c.id}  ${c.name}  ·  📁 ${c.folderName}  ·  נרשם ${String(c.createdAt || '').slice(0, 10)}  ·  ${sheetUrl(c.sheetId)}`);
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
