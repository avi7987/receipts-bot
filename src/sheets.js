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
//  הטבלה: 5 עמודות נתונים + תיבת סימון + חותמת. ברגע שמסמנים ✓
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
  'שעה',            // B — השעה שמודפסת על הקבלה
  'ספק',            // C
  'סכום כולל',      // D — כולל טיפ, אם היה
  'מספר חשבונית',   // E
  'קטגוריה',        // F
  'הוזן במערכת',    // G — תיבת סימון. ✓ צובע את השורה
  'סומן בתאריך',    // H — נחתם אוטומטית כשמסמנים
  'קבלה',           // I — קישור להורדת התמונה
];

const COL_DATE = 0;
const COL_TIME = 1;
const COL_VENDOR = 2;
const COL_TOTAL = 3;
const COL_DOC = 4;
const COL_CATEGORY = 5;
const COL_DONE = 6;
const COL_STAMP = 7;
const COL_FILE = 8;

// עמודות הסיכום, מימין לטבלה עם עמודה ריקה מפרידה (K ו-L)
const SUMMARY_COL = 10;   // K

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
export function rowFrom(r, fileUrl = null) {
  const row = [];
  row[COL_DATE] = r.date || '';
  row[COL_TIME] = r.time || '';
  row[COL_VENDOR] = r.vendor || '';
  row[COL_TOTAL] = r.total_with_tip !== null && r.total_with_tip !== undefined ? r.total_with_tip : '';
  // מספר חשבונית הוא מזהה, לא מספר — הגרשה שומרת אפסים מובילים (0038412)
  row[COL_DOC] = r.doc_number ? `'${r.doc_number}` : '';
  row[COL_CATEGORY] = r.category || '';
  row[COL_DONE] = false;   // תיבת סימון ריקה
  row[COL_STAMP] = '';     // מתמלא אוטומטית כשמסמנים
  // לחיצה על הקישור מורידה את הקובץ ישירות, בלי מסך תצוגה של Drive
  row[COL_FILE] = fileUrl ? `=HYPERLINK("${fileUrl}";"📎 פתח")` : '';
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

  // הטבלה תמיד ממוינת לפי תאריך הקבלה, לא לפי סדר הצילום.
  // אחרי המיון השורה זזה, ולכן מאתרים מחדש איפה היא נחתה.
  let finalRow = row;
  try {
    await sortByDate(token, row);
    const found = await findRowWith(token, {
      doc_number: normDoc(values[COL_DOC]),
      date: values[COL_DATE] || null,
      total: numOf(values[COL_TOTAL]),
    });
    if (found) finalRow = found;
  } catch (e) {
    console.error('⚠️  מיון לפי תאריך נכשל (השורה נכתבה בכל זאת):', e.message);
  }

  // תיבת הסימון מוחלת על טווח הנתונים בלבד, כדי שהגיליון לא יתמלא
  // באלפי תיבות ריקות מתחת לשורה האחרונה
  await addCheckbox(token, row).catch((e) => console.error('⚠️  תיבת הסימון:', e.message));

  return finalRow;
}

/**
 * ממיין את שורות הנתונים לפי עמודת התאריך, מהישן לחדש.
 * הטווח מוגבל ל-A..G בלבד — בלוק הסיכום ב-I/J לא זז.
 */
async function sortByDate(token, lastRow) {
  if (lastRow < 3) return;            // שורה אחת בלבד — אין מה למיין

  await batchUpdate(token, [{
    sortRange: {
      range: {
        sheetId: tabGid,
        startRowIndex: 1,             // אחרי הכותרת
        endRowIndex: lastRow,
        startColumnIndex: 0,
        endColumnIndex: HEADERS.length,
      },
      // תאריך ואז שעה — כך שתי קבלות מאותו יום נשמרות בסדר שקרה בפועל
      sortSpecs: [
        { dimensionIndex: COL_DATE, sortOrder: 'ASCENDING' },
        { dimensionIndex: COL_TIME, sortOrder: 'ASCENDING' },
      ],
    },
  }]);

  // המיון מזיז תאים; מוודאים שתיבות הסימון עדיין על כל טווח הנתונים
  await batchUpdate(token, [{
    setDataValidation: {
      range: {
        sheetId: tabGid,
        startRowIndex: 1, endRowIndex: lastRow,
        startColumnIndex: COL_DONE, endColumnIndex: COL_DONE + 1,
      },
      rule: { condition: { type: 'BOOLEAN' }, showCustomUi: true },
    },
  }]);
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
  await ensureSummary(token);

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

// ── בלוק הסיכום ─────────────────────────────────────────────────────
//
//  נוסחאות חיות בעמודות I/J. ברגע שמסמנים ✓ בשורה, הסכום שלה יורד
//  מ"ממתין להזנה" ועובר ל"כבר הוזן" — בלי לגעת בכלום.
const T = colLetter(COL_TOTAL + 1);   // C
const D = colLetter(COL_DONE + 1);    // F

const SUMMARY = [
  ['סיכום', ''],
  ['ממתין להזנה', `=SUMIF($${D}$2:$${D},FALSE,$${T}$2:$${T})`],
  ['כבר הוזן', `=SUMIF($${D}$2:$${D},TRUE,$${T}$2:$${T})`],
  ['סה"כ הכל', `=SUM($${T}$2:$${T})`],
  ['קבלות ממתינות', `=COUNTIF($${D}$2:$${D},FALSE)`],
];

async function ensureSummary(token) {
  const col = colLetter(SUMMARY_COL + 1);        // I
  const next = colLetter(SUMMARY_COL + 2);       // J
  const range = encodeURIComponent(`${TAB}!${col}1:${next}${SUMMARY.length}`);

  const res = await fetch(`${API}/${SHEET_ID}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return;                            // לא קריטי — לא מפילים על זה
  const data = await res.json();
  if (data.values?.length && data.values[0]?.some(Boolean)) return;   // כבר קיים

  const put = await fetch(`${API}/${SHEET_ID}/values/${range}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ values: SUMMARY }),
  });
  if (!put.ok) return;

  // עיצוב: תוויות מודגשות, סכומים בשקלים
  await batchUpdate(token, [
    {
      repeatCell: {
        range: {
          sheetId: tabGid, startRowIndex: 0, endRowIndex: SUMMARY.length,
          startColumnIndex: SUMMARY_COL, endColumnIndex: SUMMARY_COL + 1,
        },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat',
      },
    },
    {
      repeatCell: {
        range: {
          sheetId: tabGid, startRowIndex: 0, endRowIndex: 3,
          startColumnIndex: SUMMARY_COL + 1, endColumnIndex: SUMMARY_COL + 2,
        },
        cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '#,##0.00 ₪' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
  ]).catch(() => {});
  console.log('📊 נוסף בלוק הסיכום.');
}

// ── המאזן הנוכחי ────────────────────────────────────────────────────
//
//  מחושב מהנתונים עצמם ולא נקרא מתאי הסיכום — כך שהוא לא תלוי
//  במיקום שלהם ולא יישבר אם נזיז אותם שוב.
/**
 * @returns {Promise<{pending:number, count:number, done:number, currency:string}|null>}
 */
export async function pendingSummary() {
  if (!sheetsConfigured()) return null;

  try {
    const token = await accessToken();
    const totalCol = colLetter(COL_TOTAL + 1);
    const doneCol = colLetter(COL_DONE + 1);
    const range = encodeURIComponent(`${TAB}!${totalCol}2:${doneCol}`);

    const res = await fetch(`${API}/${SHEET_ID}/values/${range}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;

    const rows = (await res.json()).values || [];
    const doneOffset = COL_DONE - COL_TOTAL;

    let pending = 0;
    let done = 0;
    let count = 0;
    for (const r of rows) {
      const amount = numOf(r[0]);
      if (amount === null) continue;
      if (String(r[doneOffset]).toUpperCase() === 'TRUE') {
        done += amount;
      } else {
        pending += amount;
        count++;
      }
    }
    return {
      pending: Math.round(pending * 100) / 100,
      done: Math.round(done * 100) / 100,
      count,
      currency: 'ILS',
    };
  } catch (e) {
    console.error('חישוב המאזן נכשל:', e.message || e);
    return null;
  }
}

// ── חיפוש שורה קיימת ────────────────────────────────────────────────
//
//  הזיכרון המקומי של הבוט לא יודע שמחקת שורה מהגיליון. לכן לפני
//  שמכריזים "כבר קלטתי את זה", בודקים שהשורה באמת עדיין שם.
//  הגיליון הוא מקור האמת, לא הזיכרון.
/**
 * @param {{doc_number?:string|null, date?:string|null, total?:number|null}} key
 * @returns {Promise<number|null>} מספר השורה, או null אם אינה קיימת
 */
export async function findRow(key) {
  if (!key || !sheetsConfigured()) return null;
  const token = await accessToken();
  await ensureSetup(token);
  return findRowWith(token, key);
}

/** אותו חיפוש, עם טוקן קיים — לשימוש פנימי אחרי כתיבה ומיון. */
async function findRowWith(token, key) {
  if (!key) return null;

  const last = colLetter(HEADERS.length);
  const res = await fetch(`${API}/${SHEET_ID}/values/${encodeURIComponent(`${TAB}!A2:${last}`)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Sheets read ${res.status}`);
  const rows = (await res.json()).values || [];

  const wantDoc = normDoc(key.doc_number);
  const wantTotal = key.total === null || key.total === undefined ? null : Number(key.total);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const doc = normDoc(r[COL_DOC]);
    const total = numOf(r[COL_TOTAL]);

    // מספר חשבונית הוא המזהה החזק — אם הוא קיים בשני הצדדים, הוא מכריע
    if (wantDoc && doc) {
      if (doc === wantDoc) return i + 2;
      continue;
    }
    // אין מספר חשבונית: נופלים לשילוב תאריך + סכום
    if (wantTotal !== null && total !== null && Math.abs(total - wantTotal) < 0.005) {
      if (!key.date || sameDate(r[COL_DATE], key.date)) return i + 2;
    }
  }
  return null;
}

export function normDoc(v) {
  const s = String(v ?? '').replace(/^'/, '').trim();
  return s || null;
}

// "494.00 ₪" → 494
export function numOf(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^\d.,-]/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// הגיליון מציג dd/MM/yyyy, אצלנו זה YYYY-MM-DD
export function sameDate(cell, iso) {
  const s = String(cell ?? '').trim();
  if (!s || !iso) return false;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  const asIso = m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s;
  return asIso === iso;
}

// ── חותמת זמן על שורות שסומנו ───────────────────────────────────────
//
//  Google Sheets לא יודעת לרשום לבד מתי תא שונה. במקום להכריח אותך
//  להתקין סקריפט בגיליון, הבוט בודק אחת לדקה: כל שורה שמסומנת ✓
//  ואין לה חותמת — מקבלת אחת. פעם אחת, ואז לא נוגעים בה שוב.
/** @returns {Promise<number>} כמה שורות נחתמו */
export async function stampChecked() {
  if (!sheetsConfigured()) return 0;

  const token = await accessToken();
  await ensureSetup(token);

  const doneCol = colLetter(COL_DONE + 1);
  const stampCol = colLetter(COL_STAMP + 1);
  const range = encodeURIComponent(`${TAB}!${doneCol}2:${stampCol}`);

  const res = await fetch(`${API}/${SHEET_ID}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Sheets read ${res.status}`);
  const rows = (await res.json()).values || [];

  const updates = [];
  rows.forEach((r, i) => {
    const checked = String(r[0]).toUpperCase() === 'TRUE';
    const stamp = r[COL_STAMP - COL_DONE];
    if (checked && !stamp) {
      updates.push({
        range: `${TAB}!${stampCol}${i + 2}`,
        values: [[nowInIsrael()]],
      });
    }
  });
  if (!updates.length) return 0;

  const put = await fetch(`${API}/${SHEET_ID}/values:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }),
  });
  if (!put.ok) throw new Error(`Sheets stamp ${put.status}: ${(await put.text()).slice(0, 200)}`);
  return updates.length;
}

function nowInIsrael() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
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
    // כותרת כהה עם טקסט לבן — הפרדה ברורה מהנתונים
    {
      repeatCell: {
        range: { sheetId: gid, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: HEADERS.length },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.149, green: 0.196, blue: 0.219 },
            textFormat: { bold: true, fontSize: 11, foregroundColor: { red: 1, green: 1, blue: 1 } },
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: gid, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 38 },
        fields: 'pixelSize',
      },
    },
    // יישור לפי סוג התוכן
    ...[[COL_DATE, 'CENTER'], [COL_TIME, 'CENTER'], [COL_VENDOR, 'RIGHT'], [COL_TOTAL, 'RIGHT'], [COL_DOC, 'CENTER'],
      [COL_CATEGORY, 'CENTER'], [COL_DONE, 'CENTER'], [COL_STAMP, 'CENTER'], [COL_FILE, 'CENTER'],
    ].map(([i, a]) => ({
      repeatCell: {
        range: all(i, i + 1),
        cell: { userEnteredFormat: { horizontalAlignment: a, verticalAlignment: 'MIDDLE' } },
        fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment)',
      },
    })),
    // הסכום מודגש — זה המספר שהעין מחפשת
    {
      repeatCell: {
        range: all(COL_TOTAL, COL_TOTAL + 1),
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat',
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
    // שעת הקבלה
    {
      repeatCell: {
        range: all(COL_TIME, COL_TIME + 1),
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'HH:mm' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
    // חותמת הסימון — תאריך ושעה
    {
      repeatCell: {
        range: all(COL_STAMP, COL_STAMP + 1),
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'dd/MM/yyyy HH:mm' } } },
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
            condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$F2=TRUE' }] },
            format: {
              backgroundColor: { red: 0.85, green: 0.94, blue: 0.83 },
              textFormat: { foregroundColor: { red: 0.42, green: 0.46, blue: 0.42 } },
            },
          },
        },
      },
    },
    // רוחב עמודות נוח
    ...[[0, 100], [1, 70], [2, 180], [3, 120], [4, 130], [5, 120], [6, 110], [7, 145], [8, 80], [10, 150], [11, 125]].map(([i, px]) => ({
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
  vendor: 'ספק',
  category: 'קטגוריה',
};

export function hebField(f) {
  return FIELD_HE[f] || f;
}
