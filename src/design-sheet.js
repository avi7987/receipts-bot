// =====================================================================
//  design-sheet.js — נותן לגיליון מראה מוגמר.
//
//  הרצה:  npm run design
//
//  בונה מחדש את כל השכבה הוויזואלית: כותרת, פסים מתחלפים, מסגרות,
//  רוחבי עמודות, פורמטים, וכרטיס סיכום. בטוח להרצה חוזרת — כללי
//  עיצוב קיימים נמחקים לפני שנכתבים מחדש, כדי שלא ייערמו כפילויות.
//  לא נוגע בנתונים עצמם.
// =====================================================================
import 'dotenv/config';
import crypto from 'crypto';
import { HEADERS } from './sheets.js';

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TAB = process.env.GOOGLE_SHEET_TAB || 'הוצאות';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

// ── פלטה ────────────────────────────────────────────────────────────
const rgb = (r, g, b) => ({ red: r / 255, green: g / 255, blue: b / 255 });
const INK = rgb(38, 50, 56);        // כותרת כהה
const PAPER = rgb(255, 255, 255);
const STRIPE = rgb(246, 248, 250);  // פס מתחלף עדין
const LINE = rgb(218, 224, 230);    // קווי הפרדה
const DONE_BG = rgb(230, 244, 234); // ירוק של שורה שהוזנה
const DONE_INK = rgb(120, 134, 124);
const CARD = rgb(241, 245, 249);

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

// ── מצב נוכחי ───────────────────────────────────────────────────────
const meta = await (await fetch(
  `${API}/${SHEET_ID}?fields=sheets(properties(title,sheetId),conditionalFormats,bandedRanges)`,
  { headers: auth },
)).json();
const sheet = (meta.sheets || []).find((s) => s.properties?.title === TAB);
if (!sheet) { console.error(`❌ אין לשונית "${TAB}"`); process.exit(1); }
const gid = sheet.properties.sheetId;

const rowsA = ((await (await fetch(`${API}/${SHEET_ID}/values/${R('A2:A')}`, { headers: auth })).json()).values) || [];
const last = rowsA.length + 1;            // מספר השורה האחרונה עם נתונים
const N = HEADERS.length;                 // 8 עמודות
console.log(`לשונית "${TAB}" · ${rowsA.length} שורות נתונים\n`);

// ── ניקוי שאריות הסיכום הישן ────────────────────────────────────────
await fetch(`${API}/${SHEET_ID}/values/${R('J1:N12')}:clear`, { method: 'POST', headers: jauth, body: '{}' });

// ── כרטיס הסיכום, במקומו החדש ───────────────────────────────────────
const T = 'D';   // עמודת הסכום
const D = 'G';   // עמודת הסימון
await fetch(`${API}/${SHEET_ID}/values/${R('K1:L5')}?valueInputOption=USER_ENTERED`, {
  method: 'PUT', headers: jauth,
  body: JSON.stringify({
    values: [
      ['סיכום', ''],
      ['ממתין להזנה', `=SUMIF($${D}$2:$${D},FALSE,$${T}$2:$${T})`],
      ['כבר הוזן', `=SUMIF($${D}$2:$${D},TRUE,$${T}$2:$${T})`],
      ['סה"כ הכל', `=SUM($${T}$2:$${T})`],
      ['קבלות ממתינות', `=COUNTIF($${D}$2:$${D},FALSE)`],
    ],
  }),
});

// ── בניית בקשות העיצוב ──────────────────────────────────────────────
const req = [];
const range = (r1, r2, c1, c2) => ({ sheetId: gid, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 });

// מוחקים עיצוב קיים כדי שלא ייערם
(sheet.conditionalFormats || []).forEach((_, i, a) => req.push({ deleteConditionalFormatRule: { sheetId: gid, index: a.length - 1 - i } }));
(sheet.bandedRanges || []).forEach((b) => req.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } }));

// כותרת קפואה + גובה שורה נוח
req.push({
  updateSheetProperties: {
    properties: { sheetId: gid, gridProperties: { frozenRowCount: 1 } },
    fields: 'gridProperties.frozenRowCount',
  },
});
req.push({
  updateDimensionProperties: {
    range: { sheetId: gid, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
    properties: { pixelSize: 38 },
    fields: 'pixelSize',
  },
});

// שורת הכותרת — כהה, לבן, מודגש, ממורכז
req.push({
  repeatCell: {
    range: range(0, 1, 0, N),
    cell: {
      userEnteredFormat: {
        backgroundColor: INK,
        textFormat: { bold: true, fontSize: 11, foregroundColor: PAPER },
        horizontalAlignment: 'CENTER',
        verticalAlignment: 'MIDDLE',
      },
    },
    fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
  },
});

// גוף הטבלה — רקע לבן, יישור אנכי, גודל אחיד
req.push({
  repeatCell: {
    range: { sheetId: gid, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: N },
    cell: {
      userEnteredFormat: {
        backgroundColor: PAPER,
        textFormat: { fontSize: 10, foregroundColor: INK },
        verticalAlignment: 'MIDDLE',
      },
    },
    fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)',
  },
});

// פסים מתחלפים — עוזר לעקוב אחרי שורה ארוכה
if (last >= 2) {
  req.push({
    addBanding: {
      bandedRange: {
        range: range(1, last, 0, N),
        rowProperties: { firstBandColor: PAPER, secondBandColor: STRIPE },
      },
    },
  });
}

// פורמטים לפי עמודה
const fmt = (col, numberFormat, align) => req.push({
  repeatCell: {
    range: { sheetId: gid, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
    cell: { userEnteredFormat: { ...(numberFormat ? { numberFormat } : {}), ...(align ? { horizontalAlignment: align } : {}) } },
    fields: `userEnteredFormat(${[numberFormat && 'numberFormat', align && 'horizontalAlignment'].filter(Boolean).join(',')})`,
  },
});
fmt(0, { type: 'DATE', pattern: 'dd/MM/yyyy' }, 'CENTER');            // תאריך
fmt(1, { type: 'DATE_TIME', pattern: 'HH:mm' }, 'CENTER');            // שעת הקבלה
fmt(2, null, 'RIGHT');                                                // ספק
fmt(3, { type: 'CURRENCY', pattern: '#,##0.00 ₪' }, 'RIGHT');         // סכום
fmt(4, null, 'CENTER');                                               // מספר חשבונית
fmt(5, null, 'CENTER');                                               // קטגוריה
fmt(6, null, 'CENTER');                                               // תיבת סימון
fmt(7, { type: 'DATE_TIME', pattern: 'dd/MM/yyyy HH:mm' }, 'CENTER'); // חותמת הסימון
fmt(8, null, 'CENTER');                                               // קישור

// הסכום מודגש — זה המספר שהעין מחפשת
req.push({
  repeatCell: {
    range: { sheetId: gid, startRowIndex: 1, startColumnIndex: 3, endColumnIndex: 4 },
    cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 10 } } },
    fields: 'userEnteredFormat.textFormat',
  },
});

// רוחבי עמודות
[[0, 100], [1, 70], [2, 190], [3, 125], [4, 135], [5, 120], [6, 110], [7, 145], [8, 80], [9, 26], [10, 155], [11, 130]]
  .forEach(([i, px]) => req.push({
    updateDimensionProperties: {
      range: { sheetId: gid, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
      properties: { pixelSize: px },
      fields: 'pixelSize',
    },
  }));

// מסגרות עדינות סביב הטבלה
if (last >= 2) {
  const solid = { style: 'SOLID', color: LINE };
  req.push({
    updateBorders: {
      range: range(0, last, 0, N),
      innerHorizontal: solid, innerVertical: solid,
      top: solid, bottom: solid, left: solid, right: solid,
    },
  });
}

// שורה שסומנה — ירוקה, טקסט מאפיר וקו חוצה
req.push({
  addConditionalFormatRule: {
    index: 0,
    rule: {
      ranges: [{ sheetId: gid, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: N }],
      booleanRule: {
        condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$G2=TRUE' }] },
        format: { backgroundColor: DONE_BG, textFormat: { foregroundColor: DONE_INK } },
      },
    },
  },
});

// ── כרטיס הסיכום ────────────────────────────────────────────────────
req.push({ mergeCells: { range: range(0, 1, 10, 12), mergeType: 'MERGE_ALL' } });
req.push({
  repeatCell: {
    range: range(0, 1, 10, 12),
    cell: {
      userEnteredFormat: {
        backgroundColor: INK,
        textFormat: { bold: true, fontSize: 11, foregroundColor: PAPER },
        horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
      },
    },
    fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
  },
});
req.push({
  repeatCell: {
    range: range(1, 5, 11, 12),
    cell: {
      userEnteredFormat: {
        backgroundColor: CARD,
        textFormat: { bold: true, fontSize: 10, foregroundColor: INK },
        horizontalAlignment: 'RIGHT', verticalAlignment: 'MIDDLE',
      },
    },
    fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
  },
});
req.push({
  repeatCell: {
    range: range(1, 4, 11, 12),
    cell: {
      userEnteredFormat: {
        backgroundColor: CARD,
        numberFormat: { type: 'CURRENCY', pattern: '#,##0.00 ₪' },
        textFormat: { bold: true, fontSize: 11, foregroundColor: INK },
        horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE',
      },
    },
    fields: 'userEnteredFormat(backgroundColor,numberFormat,textFormat,horizontalAlignment,verticalAlignment)',
  },
});
req.push({
  repeatCell: {
    range: range(4, 5, 11, 12),
    cell: {
      userEnteredFormat: {
        backgroundColor: CARD,
        numberFormat: { type: 'NUMBER', pattern: '0' },
        textFormat: { bold: true, fontSize: 11, foregroundColor: INK },
        horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE',
      },
    },
    fields: 'userEnteredFormat(backgroundColor,numberFormat,textFormat,horizontalAlignment,verticalAlignment)',
  },
});
{
  const solid = { style: 'SOLID', color: LINE };
  req.push({
    updateBorders: {
      range: range(0, 5, 10, 12),
      innerHorizontal: solid, innerVertical: solid,
      top: solid, bottom: solid, left: solid, right: solid,
    },
  });
}

// ── שליחה ───────────────────────────────────────────────────────────
const res = await fetch(`${API}/${SHEET_ID}:batchUpdate`, {
  method: 'POST', headers: jauth, body: JSON.stringify({ requests: req }),
});
if (!res.ok) {
  console.error('❌ העיצוב נכשל:', (await res.text()).slice(0, 400));
  process.exit(1);
}
console.log(`✅ הוחלו ${req.length} שינויי עיצוב.`);
console.log('   כותרת קפואה · פסים מתחלפים · מסגרות · פורמטים · כרטיס סיכום');
