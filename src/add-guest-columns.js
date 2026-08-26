// =====================================================================
//  add-guest-columns.js — מוסיף לגיליון קיים את "סועדים" ו"אורחים / לקוח".
//
//  הרצה:  npm run add-guests
//  בטוח להרצה חוזרת — אם העמודות קיימות, לא נוגע.
//
//  העמודות נכנסות אחרי "קטגוריה", כדי שכל מה שקשור לתוכן ההוצאה
//  יישב יחד, ותיבת הסימון והחותמת יישארו בסוף.
// =====================================================================
import 'dotenv/config';
import crypto from 'crypto';

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TAB = process.env.GOOGLE_SHEET_TAB || 'הוצאות';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

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

const meta = await (await fetch(`${API}/${SHEET_ID}?fields=sheets(properties(title,sheetId))`, { headers: auth })).json();
const gid = (meta.sheets || []).find((s) => s.properties?.title === TAB)?.properties?.sheetId;
if (gid === undefined) { console.error(`❌ אין לשונית "${TAB}"`); process.exit(1); }

const headRow = ((await (await fetch(`${API}/${SHEET_ID}/values/${R('A1:N1')}`, { headers: auth })).json()).values || [[]])[0];
console.log('כותרות כרגע:', headRow.filter(Boolean).join(' · '), '\n');

if (headRow[7] === 'לקוח' && headRow[8] === 'אורחים') {
  console.log('✅ העמודות כבר קיימות — אין מה לעשות.');
  process.exit(0);
}

// טופס ההוצאות דורש באוכל גם "לקוח" וגם "שמות סועדים" — שני שדות
// נפרדים. לכן העמודה שאיחדה אותם מתפצלת לשתיים.

// שלב 1: הכותרת הישנה "אורחים / לקוח" הופכת ל"לקוח"
if (headRow[7] === 'אורחים / לקוח') {
  await fetch(`${API}/${SHEET_ID}/values/${R('H1')}?valueInputOption=RAW`, {
    method: 'PUT', headers: jauth, body: JSON.stringify({ values: [['לקוח']] }),
  });
  console.log('שונה שם העמודה H ל-"לקוח".');
}

// שלב 2: עמודה חדשה "אורחים" אחרי "לקוח"
const ins = await fetch(`${API}/${SHEET_ID}:batchUpdate`, {
  method: 'POST', headers: jauth,
  body: JSON.stringify({
    requests: [{
      insertDimension: {
        range: { sheetId: gid, dimension: 'COLUMNS', startIndex: 8, endIndex: 9 },
        inheritFromBefore: false,
      },
    }],
  }),
});
if (!ins.ok) { console.error('❌ ההוספה נכשלה:', (await ins.text()).slice(0, 250)); process.exit(1); }

await fetch(`${API}/${SHEET_ID}/values/${R('I1')}?valueInputOption=RAW`, {
  method: 'PUT', headers: jauth, body: JSON.stringify({ values: [['אורחים']] }),
});

console.log('✅ נוספה עמודת "אורחים" אחרי "לקוח".');
console.log('   הרץ עכשיו  npm run design  כדי ליישר את העיצוב.');
