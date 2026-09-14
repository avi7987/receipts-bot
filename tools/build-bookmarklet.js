// =====================================================================
//  build-bookmarklet.js — בונה את הסימנייה שלך מתוך fill-form.js.
//
//  הרצה:  npm run bookmarklet
//
//  למה זה קיים: הכתובת והמפתח מוצבים בקוד לפני הקידוד. עשיתי את
//  ההצבה ידנית פעם אחת, ובפעם הבאה ששכחתי — הסימנייה יצאה עם
//  __API__ בפנים והכפתור פשוט לא עשה כלום. עכשיו זו פקודה אחת.
//
//  המפתח נגזר מ-LINK_SECRET באותה נוסחה שהשרת משתמש בה, כדי
//  שהשניים לא יוכלו להיפרד. הבנייה עצמה משותפת עם הסימניות של
//  העמיתים (src/bookmarklet.js).
// =====================================================================
import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildBookmarklet } from '../src/bookmarklet.js';

const here = path.dirname(fileURLToPath(import.meta.url));

//  בניית בדיקה: ROWS_SHEET_ID=<גיליון> npm run bookmarklet
//  השורות הממתינות בגיליון הזה נטמעות בסימנייה, והיא נכתבת לקובץ
//  נפרד — כדי שהסימנייה הרגילה שלך לא תידרס בגרסת בדיקה.
const ROWS_SHEET = (process.env.ROWS_SHEET_ID || '').trim();
const OUT = path.join(here, ROWS_SHEET ? 'fill-form.test.bookmarklet.txt' : 'fill-form.bookmarklet.txt');

const secret = process.env.LINK_SECRET;
if (!secret) { console.error('❌ חסר LINK_SECRET ב-.env'); process.exit(1); }

const api = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const key = crypto.createHash('sha256').update(`${secret}:pending`).digest('hex').slice(0, 32);

let rows = null;
if (ROWS_SHEET) {
  // מודול הגיליונות קורא את המזהה בטעינה, ולכן מגדירים לפני הייבוא
  process.env.GOOGLE_SHEET_ID = ROWS_SHEET;
  const { pendingRows } = await import('../src/sheets.js');
  rows = await pendingRows();
  if (!rows.length) { console.error('❌ אין שורות ממתינות בגיליון הזה'); process.exit(1); }
}

let built;
try {
  built = buildBookmarklet({ api, key, rows });
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
fs.writeFileSync(OUT, built.text);

console.log(`✅ נבנתה סימנייה v${built.version}${rows ? ' — מצב בדיקה' : ''}`);
if (rows) {
  for (const r of rows) console.log(`   · ${r.vendor} · ${r.amount} ₪ · ${r.category} · קובץ: ${r.file ? 'יש' : 'אין'}`);
}
console.log(`   כתובת: ${api}`);
console.log(`   גודל:  ${fs.statSync(OUT).size.toLocaleString('he-IL')} תווים`);
console.log(`   קובץ:  ${OUT}`);
