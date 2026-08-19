// =====================================================================
//  migrate-sheet.js — מעביר גיליון קיים מהמבנה הישן (4 עמודות) לחדש (7).
//
//  הרצה:  npm run migrate
//
//  מה קורה: הנתונים הקיימים נקראים, הגיליון מנוקה מעיצוב ישן,
//  והשורות נכתבות מחדש במיקומים החדשים. ספק וקטגוריה נשארים ריקים
//  בשורות ישנות — הבוט לא ידע אותם בדיעבד, ולא נמציא.
//
//  בטוח להרצה חוזרת: אם הגיליון כבר במבנה החדש, הסקריפט לא נוגע.
// =====================================================================
import 'dotenv/config';
import crypto from 'crypto';
import { HEADERS } from './sheets.js';

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const TAB = process.env.GOOGLE_SHEET_TAB || 'הוצאות';
const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
const SA_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

if (!SHEET_ID || !SA_EMAIL || !SA_KEY) {
  console.error('❌ חסרות הגדרות Google Sheets ב-.env');
  process.exit(1);
}

// ── אימות ───────────────────────────────────────────────────────────
const b64 = (s) => Buffer.from(s).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const claim = b64(JSON.stringify({
  iss: SA_EMAIL,
  scope: 'https://www.googleapis.com/auth/spreadsheets',
  aud: 'https://oauth2.googleapis.com/token',
  iat: now, exp: now + 3600,
}));
const signer = crypto.createSign('RSA-SHA256');
signer.update(`${header}.${claim}`);
const jwt = `${header}.${claim}.${b64(signer.sign(SA_KEY))}`;

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }),
});
const TOKEN = (await tokenRes.json()).access_token;
if (!TOKEN) { console.error('❌ אימות מול גוגל נכשל'); process.exit(1); }

const auth = { Authorization: `Bearer ${TOKEN}` };
const jsonAuth = { ...auth, 'Content-Type': 'application/json' };
const R = (a) => encodeURIComponent(`${TAB}!${a}`);

// ── קריאת המצב הקיים ────────────────────────────────────────────────
const meta = await (await fetch(
  `${API}/${SHEET_ID}?fields=sheets(properties(title,sheetId),conditionalFormats)`,
  { headers: auth },
)).json();

const sheet = (meta.sheets || []).find((s) => s.properties?.title === TAB);
if (!sheet) { console.error(`❌ לא נמצאה לשונית "${TAB}"`); process.exit(1); }
const gid = sheet.properties.sheetId;

const cur = await (await fetch(`${API}/${SHEET_ID}/values/${R('A1:G')}`, { headers: auth })).json();
const rows = cur.values || [];
const head = rows[0] || [];

if (head[1] === 'ספק' && head[6] === 'סומן בתאריך') {
  console.log('✅ הגיליון כבר במבנה החדש — אין מה להעביר.');
  process.exit(0);
}

const data = rows.slice(1).filter((r) => r.some((c) => String(c || '').trim() !== ''));
console.log(`נמצאו ${data.length} שורות נתונים במבנה הישן.\n`);

// ── מיפוי: ישן → חדש ────────────────────────────────────────────────
//  ישן:  A תאריך | B סכום | C מספר חשבונית | D ✓
//  חדש:  A תאריך | B ספק | C סכום | D מספר | E קטגוריה | F ✓ | G חותמת
const migrated = data.map((r) => {
  const [date = '', total = '', doc = '', done = ''] = r;
  const checked = String(done).toUpperCase() === 'TRUE';
  return [
    date,
    '',                                   // ספק — לא היה במבנה הישן
    total,
    doc ? `'${String(doc).replace(/^'/, '')}` : '',
    '',                                   // קטגוריה — לא היה
    checked,
    '',                                   // חותמת — תיווצר בסימון הבא
  ];
});

migrated.forEach((r, i) => {
  console.log(`  ${i + 2}: ${r[0]} · ${r[2]} · ${String(r[3]).replace(/^'/, '')} ${r[5] ? '☑' : '☐'}`);
});

// ── ניקוי עיצוב ישן ─────────────────────────────────────────────────
const requests = [];
const cfCount = (sheet.conditionalFormats || []).length;
for (let i = cfCount - 1; i >= 0; i--) {
  requests.push({ deleteConditionalFormatRule: { sheetId: gid, index: i } });
}
requests.push({
  setDataValidation: { range: { sheetId: gid, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 10 } },
});
if (requests.length) {
  const res = await fetch(`${API}/${SHEET_ID}:batchUpdate`, {
    method: 'POST', headers: jsonAuth, body: JSON.stringify({ requests }),
  });
  console.log(`\nניקוי עיצוב ישן: ${res.ok ? 'בוצע' : 'נכשל ' + res.status}`);
}

// ── ניקוי ערכים וכתיבה מחדש ─────────────────────────────────────────
await fetch(`${API}/${SHEET_ID}/values/${R('A1:J1000')}:clear`, {
  method: 'POST', headers: jsonAuth, body: '{}',
});

const values = [HEADERS, ...migrated];
const write = await fetch(
  `${API}/${SHEET_ID}/values/${R(`A1:G${values.length}`)}?valueInputOption=USER_ENTERED`,
  { method: 'PUT', headers: jsonAuth, body: JSON.stringify({ values }) },
);
console.log(`כתיבת המבנה החדש: ${write.ok ? 'בוצע' : 'נכשל ' + (await write.text()).slice(0, 200)}`);

console.log('\n✅ ההעברה הושלמה.');
console.log('   הבוט ישלים את העיצוב (תיבות סימון, צביעה, סיכום) בהרצה הבאה שלו.');
