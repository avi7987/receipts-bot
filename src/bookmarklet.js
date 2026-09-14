// =====================================================================
//  bookmarklet.js — בונה סימניית "מילוי טופס" לכתובת ולמפתח נתונים.
//
//  משותף לסימנייה שלך (npm run bookmarklet) ולסימנייה של כל עמית
//  (add-colleague). אותה בנייה בדיוק — כדי שתיקון בסימנייה אחת לא
//  יישכח בשנייה.
// =====================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'tools', 'fill-form.js');

/**
 * @param {{api:string, key:string, rows?:Array<object>|null}} opts
 * @returns {{text:string, version:string}}
 */
export function buildBookmarklet({ api, key, rows = null }) {
  // https ולא http: הסימנייה רצה בתוך דף של ServiceNow, והדפדפן חוסם
  // קריאה ל-http מדף מאובטח.
  const base = String(api || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) throw new Error(`הכתובת חייבת להיות https. כרגע: ${base || '(ריק)'}`);
  if (!key) throw new Error('חסר מפתח');

  let src = fs.readFileSync(SRC, 'utf8');
  if (!src.includes('__API__') || !src.includes('__KEY__')) {
    throw new Error('אין ב-fill-form.js את הסמנים __API__ / __KEY__');
  }
  src = src.replace('__API__', base).replace('__KEY__', key);

  if (rows) {
    // מחרוזת JS תקנית שמכילה JSON — היא מחליפה את המחרוזת '__ROWS__'
    src = src.replace("'__ROWS__'", JSON.stringify(JSON.stringify(rows)));
  }

  return {
    text: `javascript:${encodeURIComponent(src)}`,
    version: />v(\d+)</.exec(src)?.[1] || '?',
  };
}
