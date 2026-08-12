// =====================================================================
//  sheets.js — כתיבת השורות ל-Google Sheets.
//
//  ההתחברות היא דרך "חשבון שירות" (Service Account): חשבון גוגל של
//  המערכת, לא שלך. מספיק לשתף איתו את הגיליון בהרשאת עורך, וזהו —
//  אין מסך התחברות, אין טוקן שפג, ואף אחד לא צריך לאשר כלום מחדש.
//
//  אין כאן ספריות כבדות: חתימת ה-JWT נעשית עם crypto המובנה של Node,
//  ושאר הקריאות הן fetch רגיל — בדיוק כמו שאר הפרויקט.
//
//  הטבלה מכוונת: 3 עמודות נתונים + תיבת סימון. ברגע שמסמנים ✓
//  השורה נצבעת בירוק אוטומטית — סימן שהקבלה כבר הוזנה בארגון.
// =====================================================================
import 'dotenv/config';
import crypto from 'crypto';

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const TAB = process.env.GOOGLE_SHEET_TAB || 'הוצאות';
const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
const SA_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

// כותרות הטבלה. הסדר כאן הוא הסדר בגיליון — אל תשנה בלי לעדכן את rowFrom.
export const HEADERS = [
  'תאריך',          // A
  'סכום כולל',      // B — כולל טיפ, אם היה
  'מספר חשבונית',   // C
  'הוזן במערכת',    // D — תיבת סימון. ✓ צובע את השורה
];

const COL_DATE = 0;
const COL_TOTAL = 1;
const COL_DOC = 2;
const COL_DONE = 3;

export function sheetsConfigured() {
  return !!(SHEET_ID && SA_EMAIL && SA_KEY);
}

// ה-gid של הלשונית — מתמלא ב-ensureSetup, כדי שהקישור בהודעה יצביע
// על הלשונית הנכונה ולא על הראשונה בגיליון.
let tabGid = null;

export function sheetUrl(rowNumber) {
  const base = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
  if (tabGid === null) return base;
  return rowNumber ? `${base}#gid=${tabGid}&range=A${rowNumber}` : `${base}#gid=${tabGid}`;
}

// ── בניית שורה מתוך תוצאת הקריאה ────────────────────────────────────
/**
 * @param {object} r  מה ש-vision.js החזיר
 */
export function rowFrom(r) {
  const row = [];
  row[COL_DATE] = r.date || '';
  row[COL_TOTAL] = r.total_with_tip !== null && r.total_with_tip !== undefined ? r.total_with_tip : '';
  // מספר חשבונית הוא מזהה, לא מספר — הגרשה שומרת אפסים מובילים (0038412)
  row[COL_DOC] = r.doc_number ? `'${r.doc_number}` : '';
  row[COL_DONE] = false;   // תיבת סימון ריקה
  return row;
}

// ── כתיבה בפועל ─────────────────────────────────────────────────────
/**
 * מוסיף שורה לגיליון ומחזיר את מספר השורה שנכתבה.
 * @returns {Promise<number|null>}
 */
export async function appendRow(values) {
  if (!sheetsConfigured()) throw new Error('sheets-not-configured');

  const token = await accessToken();
  await ensureSetup(token);

  // מחשבים את השורה בעצמנו במקום להשתמש ב-append של גוגל.
  // הסיבה: append מזהה את "סוף הטבלה" גם לפי עיצוב ואימות נתונים,
  // לא רק לפי תוכן — ותיבות סימון על העמודה היו מקפיצות אותו לשורה 1001.
  const row = await nextRow(token);
  const last = colLetter(HEADERS.length);
  const range = encodeURIComponent(`${TAB}!A${row}:${last}${row}`);

  const res = await fetch(`${API}/${SHEET_ID}/values/${range}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ values: [values] }),
  });
  if (!res.ok) throw new Error(`Sheets write ${res.status}: ${(await res.text()).slice(0, 300)}`);

  // תיבת הסימון מוחלת על השורה החדשה בלבד, כדי שהגיליון לא יתמלא
  // באלפי תיבות ריקות מתחת לשורה האחרונה
  await addCheckbox(token, row).catch((e) => console.error('⚠️  תיבת הסימון:', e.message));

  return row;
}

/** השורה הפנויה הראשונה — לפי תוכן בלבד. לעולם לא מעל שורת הכותרת. */
async function nextRow(token) {
  const range = encodeURIComponent(`${TAB}!A:${colLetter(HEADERS.length)}`);
  const res = await fetch(`${API}/${SHEET_ID}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Sheets read ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return Math.max(2, (data.values?.length || 1) + 1);
}

async function addCheckbox(token, row) {
  return batchUpdate(token, [{
    setDataValidation: {
      range: {
        sheetId: tabGid,
        startRowIndex: row - 1, endRowIndex: row,
        startColumnIndex: COL_DONE, endColumnIndex: COL_DONE + 1,
      },
      rule: { condition: { type: 'BOOLEAN' }, showCustomUi: true },
    },
  }]);
}

/** מריץ את ההקמה בלבד (בלי לכתוב שורה) — בשביל npm run check. */
export async function setupSheet() {
  if (!sheetsConfigured()) throw new Error('sheets-not-configured');
  const token = await accessToken();
  await ensureSetup(token);
  return { tab: TAB, gid: tabGid, url: sheetUrl() };
}

// ── הקמת הלשונית: יצירה, כותרות, עיצוב, תיבות סימון ─────────────────
let setupDone = false;

async function ensureSetup(token) {
  if (setupDone) return;

  const res = await fetch(
    `${API}/${SHEET_ID}?fields=sheets(properties(title,sheetId),conditionalFormats)`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) },
  );
  if (!res.ok) throw new Error(`Sheets get ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();

  let sheet = (data.sheets || []).find((s) => s.properties?.title === TAB);

  if (!sheet) {
    const add = await batchUpdate(token, [
      { addSheet: { properties: { title: TAB, rightToLeft: true } } },
    ]);
    tabGid = add?.replies?.[0]?.addSheet?.properties?.sheetId ?? null;
    sheet = { properties: { sheetId: tabGid }, conditionalFormats: [] };
    console.log(`📄 נוצרה לשונית חדשה בגיליון: "${TAB}"`);
  } else {
    tabGid = sheet.properties.sheetId;
  }

  await ensureHeader(token);

  // העיצוב מוחל פעם אחת בלבד — אחרת היינו מוסיפים כלל צביעה בכל הרצה
  if (!sheet.conditionalFormats?.length) {
    await applyFormatting(token, tabGid);
    console.log('🎨 הוגדרו תיבות הסימון וצביעת השורות.');
  }

  setupDone = true;
}

async function ensureHeader(token) {
  const range = encodeURIComponent(`${TAB}!A1:${colLetter(HEADERS.length)}1`);
  const res = await fetch(`${API}/${SHEET_ID}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Sheets header read ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (data.values?.length && data.values[0].some(Boolean)) return;

  const put = await fetch(`${API}/${SHEET_ID}/values/${range}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ values: [HEADERS] }),
  });
  if (!put.ok) throw new Error(`Sheets header write ${put.status}: ${(await put.text()).slice(0, 300)}`);
  console.log('📄 נכתבה שורת הכותרות בגיליון.');
}

// כל העיצוב במכה אחת. טווח בלי endRowIndex = כל השורות, גם העתידיות.
async function applyFormatting(token, gid) {
  const all = (startCol, endCol) => ({ sheetId: gid, startRowIndex: 1, startColumnIndex: startCol, endColumnIndex: endCol });

  await batchUpdate(token, [
    // שורת כותרת קפואה
    {
      updateSheetProperties: {
        properties: { sheetId: gid, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    // כותרת מודגשת על רקע אפור
    {
      repeatCell: {
        range: { sheetId: gid, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: HEADERS.length },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 },
            textFormat: { bold: true },
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
      },
    },
    // תאריך בפורמט ישראלי
    {
      repeatCell: {
        range: all(COL_DATE, COL_DATE + 1),
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/MM/yyyy' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
    // סכום בשקלים
    {
      repeatCell: {
        range: all(COL_TOTAL, COL_TOTAL + 1),
        cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '#,##0.00 ₪' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
    // תיבת הסימון עצמה מוחלת בנפרד, שורה-שורה, ב-addCheckbox.
    // אסור להחיל אותה כאן על כל העמודה: זה ממלא את הגיליון בתיבות
    // ריקות ומבלבל את גוגל לגבי היכן נגמרת הטבלה.

    // ✓ → השורה נצבעת ירוק והטקסט מאפיר
    {
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [{ sheetId: gid, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: HEADERS.length }],
          booleanRule: {
            condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$D2=TRUE' }] },
            format: {
              backgroundColor: { red: 0.85, green: 0.94, blue: 0.83 },
              textFormat: { foregroundColor: { red: 0.42, green: 0.46, blue: 0.42 } },
            },
          },
        },
      },
    },
    // רוחב עמודות נוח
    ...[[0, 110], [1, 130], [2, 150], [3, 130]].map(([i, px]) => ({
      updateDimensionProperties: {
        range: { sheetId: gid, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: px },
        fields: 'pixelSize',
      },
    })),
  ]);
}

async function batchUpdate(token, requests) {
  const res = await fetch(`${API}/${SHEET_ID}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Sheets batchUpdate ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// ── אימות: JWT חתום → access token ──────────────────────────────────
let cachedToken = null;   // { token, exp }

async function accessToken() {
  if (cachedToken && Date.now() < cachedToken.exp - 60_000) return cachedToken.token;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: SA_EMAIL,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));

  let signature;
  try {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${claim}`);
    signature = b64url(signer.sign(SA_KEY));
  } catch (e) {
    throw new Error(`המפתח הפרטי של חשבון השירות לא תקין (GOOGLE_PRIVATE_KEY): ${e.message}`);
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(20000),
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`Google auth ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = await res.json();
  if (!data.access_token) throw new Error('Google auth: לא התקבל access_token');

  cachedToken = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

// ── עזר ─────────────────────────────────────────────────────────────
function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

// 1 → A, 4 → D
export function colLetter(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const FIELD_HE = {
  date: 'תאריך',
  total: 'סכום כולל',
  doc_number: 'מספר חשבונית',
  tip_extra: 'טיפ',
};

export function hebField(f) {
  return FIELD_HE[f] || f;
}
