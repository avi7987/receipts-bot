// =====================================================================
//  add-time-column.js — מוסיף לגיליון קיים את עמודת השעה, וממלא
//  אותה לשורות שכבר קיימות על ידי קריאה חוזרת של התמונות השמורות.
//
//  הרצה (בתוך הקונטיינר):  node src/add-time-column.js
//  בטוח להרצה חוזרת — אם העמודה כבר קיימת, רק ממלא מה שחסר.
// =====================================================================
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { readReceipt } from './vision.js';

const DIR = process.env.RECEIPTS_DIR || './receipts';
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TAB = process.env.GOOGLE_SHEET_TAB || 'הוצאות';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

// ── אימות ───────────────────────────────────────────────────────────
const b64 = (s) => Buffer.from(s).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const claim = b64(JSON.stringify({
  iss: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  scope: 'https://www.googleapis.com/auth/spreadsheets',
  aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
}));
const sg = crypto.createSign('RSA-SHA256');
sg.update(`${head}.${claim}`);
const TOKEN = (await (await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${head}.${claim}.${b64(sg.sign((process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n')))}`,
  }),
})).json()).access_token;
if (!TOKEN) { console.error('❌ אימות נכשל'); process.exit(1); }

const auth = { Authorization: `Bearer ${TOKEN}` };
const jauth = { ...auth, 'Content-Type': 'application/json' };
const R = (a) => encodeURIComponent(`${TAB}!${a}`);

// ── האם העמודה כבר קיימת? ───────────────────────────────────────────
const meta = await (await fetch(`${API}/${SHEET_ID}?fields=sheets(properties(title,sheetId))`, { headers: auth })).json();
const gid = (meta.sheets || []).find((s) => s.properties?.title === TAB)?.properties?.sheetId;
if (gid === undefined) { console.error(`❌ אין לשונית "${TAB}"`); process.exit(1); }

const headRow = ((await (await fetch(`${API}/${SHEET_ID}/values/${R('A1:J1')}`, { headers: auth })).json()).values || [[]])[0];

if (headRow[1] !== 'שעה') {
  console.log('מוסיף עמודה חדשה אחרי "תאריך"...');
  const ins = await fetch(`${API}/${SHEET_ID}:batchUpdate`, {
    method: 'POST', headers: jauth,
    body: JSON.stringify({
      requests: [{
        insertDimension: {
          range: { sheetId: gid, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
          inheritFromBefore: false,
        },
      }],
    }),
  });
  if (!ins.ok) { console.error('❌ הוספת העמודה נכשלה:', (await ins.text()).slice(0, 200)); process.exit(1); }
  await fetch(`${API}/${SHEET_ID}/values/${R('B1')}?valueInputOption=RAW`, {
    method: 'PUT', headers: jauth, body: JSON.stringify({ values: [['שעה']] }),
  });
  console.log('✅ העמודה נוספה.\n');
} else {
  console.log('העמודה כבר קיימת — רק ממלא מה שחסר.\n');
}

// ── מילוי השעות מהתמונות ────────────────────────────────────────────
const rows = ((await (await fetch(`${API}/${SHEET_ID}/values/${R('A2:E')}`, { headers: auth })).json()).values) || [];
let files = [];
try { files = fs.readdirSync(DIR).filter((f) => /\.(jpe?g|png|pdf|webp)$/i.test(f)); } catch { /* אין תיקייה */ }

const parsed = files.map((f) => {
  const parts = f.replace(/\.[^.]+$/, '').split('_');
  const nums = parts.filter((p) => /^\d+(\.\d+)?$/.test(p)).map(Number);
  return { file: f, date: /^\d{4}-\d{2}-\d{2}$/.test(parts[0]) ? parts[0] : null, total: nums.at(-1) ?? null };
});

const toIso = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : String(s || '').trim();
};
const numOf = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[^\d.,-]/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const updates = [];
const used = new Set();

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const rowNum = i + 2;
  if (String(r[1] || '').trim()) { console.log(`  ${rowNum}: כבר יש שעה`); continue; }

  const date = toIso(r[0]);
  const total = numOf(r[3]);
  const hit = parsed.find((p) => !used.has(p.file) && p.date === date
    && p.total !== null && total !== null && Math.abs(p.total - total) < 0.005);
  if (!hit) { console.log(`  ${rowNum}: ${date} — אין תמונה תואמת`); continue; }

  const full = path.join(DIR, hit.file);
  const ext = path.extname(hit.file).toLowerCase();
  const mime = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg';

  try {
    const data = await readReceipt(fs.readFileSync(full).toString('base64'), mime, null);
    used.add(hit.file);
    if (data.time) {
      updates.push({ range: `${TAB}!B${rowNum}`, values: [[data.time]] });
      console.log(`  ${rowNum}: ✅ ${data.time}  (${r[2] || ''})`);
    } else {
      console.log(`  ${rowNum}: — אין שעה מודפסת על הקבלה`);
    }
  } catch (e) {
    console.log(`  ${rowNum}: קריאה נכשלה — ${e.message}`);
  }
  await new Promise((res) => setTimeout(res, 4000));   // ריווח, שלא נחטוף הגבלת קצב
}

if (!updates.length) { console.log('\nאין שעות להוסיף.'); process.exit(0); }

const res = await fetch(`${API}/${SHEET_ID}/values:batchUpdate`, {
  method: 'POST', headers: jauth,
  body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }),
});
console.log(`\nכתיבת ${updates.length} שעות: ${res.ok ? '✅ בוצע' : '❌ ' + (await res.text()).slice(0, 200)}`);
