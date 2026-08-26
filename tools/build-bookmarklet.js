// =====================================================================
//  build-bookmarklet.js — בונה את הסימנייה מתוך fill-form.js.
//
//  הרצה:  npm run bookmarklet
//
//  למה זה קיים: הכתובת והמפתח מוצבים בקוד לפני הקידוד. עשיתי את
//  ההצבה ידנית פעם אחת, ובפעם הבאה ששכחתי — הסימנייה יצאה עם
//  __API__ בפנים והכפתור פשוט לא עשה כלום. עכשיו זו פקודה אחת.
//
//  המפתח נגזר מ-LINK_SECRET באותה נוסחה שהשרת משתמש בה, כדי
//  שהשניים לא יוכלו להיפרד.
// =====================================================================
import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, 'fill-form.js');
const OUT = path.join(here, 'fill-form.bookmarklet.txt');

const secret = process.env.LINK_SECRET;
if (!secret) { console.error('❌ חסר LINK_SECRET ב-.env'); process.exit(1); }

// https ולא http: הסימנייה רצה בתוך דף של ServiceNow, והדפדפן חוסם
// קריאה ל-http מדף מאובטח.
const api = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
if (!/^https:\/\//.test(api)) {
  console.error(`❌ PUBLIC_BASE_URL חייב להיות https. כרגע: ${api || '(ריק)'}`);
  process.exit(1);
}

const key = crypto.createHash('sha256').update(`${secret}:pending`).digest('hex').slice(0, 32);

let src = fs.readFileSync(SRC, 'utf8');
if (!src.includes('__API__') || !src.includes('__KEY__')) {
  console.error('❌ אין ב-fill-form.js את הסמנים __API__ / __KEY__');
  process.exit(1);
}
src = src.replace('__API__', api).replace('__KEY__', key);

fs.writeFileSync(OUT, `javascript:${encodeURIComponent(src)}`);

const version = />v(\d+)</.exec(src)?.[1] || '?';
console.log(`✅ נבנתה סימנייה v${version}`);
console.log(`   כתובת: ${api}`);
console.log(`   גודל:  ${fs.statSync(OUT).size.toLocaleString('he-IL')} תווים`);
console.log(`   קובץ:  ${OUT}`);
