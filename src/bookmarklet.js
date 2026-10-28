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
const TOOLS = path.join(here, '..', 'tools');

/**
 * @param {{api:string, key:string, rows?:Array<object>|null}} opts
 * @returns {{text:string, version:string}}
 */
export function buildBookmarklet({ api, key, rows = null, source = 'fill-form.js', version = null }) {
  // https ולא http: הסימנייה רצה בתוך דף של ServiceNow, והדפדפן חוסם
  // קריאה ל-http מדף מאובטח.
  const base = String(api || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) throw new Error(`הכתובת חייבת להיות https. כרגע: ${base || '(ריק)'}`);
  if (!key) throw new Error('חסר מפתח');

  let src = fs.readFileSync(path.join(TOOLS, source), 'utf8');
  //  כלי האבחון לא פונה לשרת ולכן אין בו סמנים — רק המילוי זקוק להם
  if (src.includes('__API__')) src = src.replace('__API__', base).replace('__KEY__', key);

  if (rows) {
    // מחרוזת JS תקנית שמכילה JSON — היא מחליפה את המחרוזת '__ROWS__'
    src = src.replace("'__ROWS__'", JSON.stringify(JSON.stringify(rows)));
  }

  return {
    text: `javascript:${encodeURIComponent(src)}`,
    version: version || />v(\d+)</.exec(src)?.[1] || '?',
  };
}
