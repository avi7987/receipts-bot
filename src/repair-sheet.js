// =====================================================================
//  repair-sheet.js — מנקה שאריות שנוצרו מהזזת עמודות.
//
//  הרצה:  npm run repair
//
//  הרקע: החלת תיבת סימון על טווח כותבת FALSE לכל תא ריק בו. בכל
//  פעם שעמודת הסימון זזה, נשארו FALSE יתומים בעמודה הישנה — ואלה
//  נראים בטבלה כמו נתונים אמיתיים.
//
//  מה נעשה כאן: מסירים אימות נתונים מכל העמודות חוץ מעמודת הסימון,
//  מוחקים ערכים בוליאניים שנשארו בעמודות טקסט, ומשלימים כותרת חסרה.
//  נתונים אמיתיים לא נגעים.
// =====================================================================
import 'dotenv/config';
import crypto from 'crypto';
import { HEADERS } from './sheets.js';

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TAB = process.env.GOOGLE_SHEET_TAB || 'הוצאות';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

const COL_GUESTS = 6;   // G
const COL_DONE = 9;     // J — היחידה שאמורה להיות תיבת סימון

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
const L = (i) => String.fromCharCode(65 + i);

const meta = await (await fetch(`${API}/${SHEET_ID}?fields=sheets(properties(title,sheetId))`, { headers: auth })).json();
const gid = (meta.sheets || []).find((s) => s.properties?.title === TAB)?.properties?.sheetId;
if (gid === undefined) { console.error(`❌ אין לשונית "${TAB}"`); process.exit(1); }

// ── 1. כותרות ───────────────────────────────────────────────────────
await fetch(`${API}/${SHEET_ID}/values/${R(`A1:${L(HEADERS.length - 1)}1`)}?valueInputOption=RAW`, {
  method: 'PUT', headers: jauth, body: JSON.stringify({ values: [HEADERS] }),
});
console.log(`✅ כותרות: ${HEADERS.join(' · ')}\n`);

// ── 2. הסרת אימות נתונים מכל העמודות חוץ מעמודת הסימון ──────────────
const clearValidation = [];
for (let i = 0; i < HEADERS.length; i++) {
  if (i === COL_DONE) continue;
  clearValidation.push({
    setDataValidation: {
      range: { sheetId: gid, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
    },
  });
}
await fetch(`${API}/${SHEET_ID}:batchUpdate`, {
  method: 'POST', headers: jauth, body: JSON.stringify({ requests: clearValidation }),
});
console.log('✅ הוסר אימות נתונים מכל העמודות חוץ מ"הוזן במערכת"\n');

// ── 3. ניקוי ערכים בוליאניים שנשארו יתומים ──────────────────────────
const grid = ((await (await fetch(
  `${API}/${SHEET_ID}/values/${R(`A2:${L(HEADERS.length - 1)}`)}?valueRenderOption=UNFORMATTED_VALUE`,
  { headers: auth },
)).json()).values) || [];

const fixes = [];
grid.forEach((row, ri) => {
  const rowNum = ri + 2;
  for (let i = 0; i < HEADERS.length; i++) {
    if (i === COL_DONE) continue;
    const v = row[i];
    if (typeof v !== 'boolean') continue;
    // סועדים אמור להיות מספר; שאר העמודות טקסט. בוליאני בהן = שארית
    fixes.push({ range: `${TAB}!${L(i)}${rowNum}`, values: [['']] });
    console.log(`  שורה ${rowNum}, עמודה ${L(i)} (${HEADERS[i]}): נמחק ${v}`);
  }
  // עמודת הסימון חייבת להיות בוליאנית
  if (typeof row[COL_DONE] !== 'boolean') {
    fixes.push({ range: `${TAB}!${L(COL_DONE)}${rowNum}`, values: [[false]] });
    console.log(`  שורה ${rowNum}: הוזן במערכת אופס ל-FALSE`);
  }
});

if (fixes.length) {
  const res = await fetch(`${API}/${SHEET_ID}/values:batchUpdate`, {
    method: 'POST', headers: jauth,
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: fixes }),
  });
  console.log(`\n${res.ok ? '✅' : '❌'} ${fixes.length} תיקונים`);
} else {
  console.log('אין שאריות לנקות.');
}

// ── 4. תיבות סימון על עמודת הסימון בלבד ─────────────────────────────
const last = grid.length + 1;
if (last >= 2) {
  await fetch(`${API}/${SHEET_ID}:batchUpdate`, {
    method: 'POST', headers: jauth,
    body: JSON.stringify({
      requests: [{
        setDataValidation: {
          range: { sheetId: gid, startRowIndex: 1, endRowIndex: last, startColumnIndex: COL_DONE, endColumnIndex: COL_DONE + 1 },
          rule: { condition: { type: 'BOOLEAN' }, showCustomUi: true },
        },
      }],
    }),
  });
  console.log(`✅ תיבות סימון על ${L(COL_DONE)}2:${L(COL_DONE)}${last}`);
}

console.log('\nהרץ עכשיו  npm run design  כדי ליישר את העיצוב.');
