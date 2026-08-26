// =====================================================================
//  format.js — ההודעה שחוזרת לקבוצה אחרי כל קבלה.
//
//  המטרה: שתראה בשנייה אחת שהקבלה נקראה נכון, בלי לפתוח את הטבלה.
//  מה שלא נקרא — מסומן במפורש, כדי שתדע להשלים ידנית.
// =====================================================================
import { hebField } from './sheets.js';

const SYMBOL = { ILS: '₪', USD: '$', EUR: '€', GBP: '£' };

export function money(amount, currency = 'ILS') {
  if (amount === null || amount === undefined) return null;
  const s = Number(amount).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sym = SYMBOL[currency];
  return sym ? `${s} ${sym}` : `${s} ${currency}`;
}

/** 2026-08-04 → 4.8.2026 */
export function heDate(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])}.${Number(m[2])}.${m[1]}`;
}

/**
 * ההודעה המלאה של קבלה שנקלטה.
 * @param {object} r      תוצאת vision
 * @param {object} meta   { row, sheetUrl, link }
 */
export function receiptMessage(r, meta = {}) {
  const lines = [];

  lines.push(`✅ *נקלט — ${r.vendor || 'ספק לא זוהה'}*`);

  const when = heDate(r.date);
  const clock = r.time ? `   🕒 ${r.time}` : '';
  lines.push(when ? `📅 ${when}${clock}` : '📅 _התאריך לא זוהה_');

  const total = money(r.total_with_tip, r.currency);
  if (total) {
    // כשהיה טיפ במזומן — מראים את החישוב, שלא יהיה מספר "מאיפה שהוא"
    const breakdown = r.tip_extra
      ? `   (${money(r.total, r.currency)} + ${money(r.tip_extra, r.currency)} טיפ)`
      : '';
    lines.push(`💰 *${total}*${breakdown}`);
  } else {
    lines.push('💰 _הסכום לא זוהה_');
  }

  lines.push(r.doc_number ? `🧾 חשבונית ${r.doc_number}` : '🧾 _מספר החשבונית לא זוהה_');
  if (r.category) lines.push(`🏷️ ${r.category}`);

  if (r.uncertain?.length) {
    lines.push('');
    lines.push(`⚠️ צריך להשלים ידנית: ${r.uncertain.map(hebField).join(', ')}`);
  }

  lines.push('');
  lines.push(meta.row ? `📊 שורה ${meta.row} בגיליון` : '📊 נוסף לגיליון');

  // המאזן אחרי הקבלה הזו — כדי לדעת איפה אתה עומד בלי לפתוח את הטבלה
  const b = meta.balance;
  if (b && b.count > 0) {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━');
    lines.push(`⏳ *ממתין להזנה: ${money(b.pending, b.currency)}*`);
    lines.push(`📄 ${b.count} ${b.count === 1 ? 'קבלה' : 'קבלות'} בהמתנה`);
  }

  if (meta.sheetUrl) {
    lines.push('');
    lines.push(meta.sheetUrl);
  }

  return lines.join('\n');
}

/** תמונה שהיא לא קבלה */
export function notReceiptMessage(reason) {
  return `🤷 זו לא נראית לי כמו קבלה, אז לא הוספתי שורה.\n${reason ? `_${reason}_\n` : ''}אם זו כן קבלה — נסה לצלם אותה שוב, ישר ומואר.`;
}

/** כשל אמיתי */
export function errorMessage(kind, detail, row = null) {
  switch (kind) {
    case 'missing-gemini-key':
      return '⚙️ חסר מפתח ה-AI (GEMINI_API_KEY). בלעדיו אני לא יכול לקרוא קבלות.';
    case 'sheets-not-configured':
      return '⚙️ החיבור ל-Google Sheets לא מוגדר עדיין. הקבלה נקראה, אבל אין לאן לכתוב אותה.';
    case 'too-large':
      return '📦 הקובץ גדול מדי בשבילי. נסה לצלם שוב באיכות רגילה.';
    case 'unsupported':
      return '🤔 אני יודע לקרוא צילומים (JPG/PNG) וקבצי PDF. הקובץ הזה בפורמט אחר.';
    case 'duplicate':
      return `♻️ *הקבלה כבר בטבלה*${detail ? `\n${detail}` : ''}`
        + `${row ? `\n📊 שורה ${row}` : ''}\n\n_לא הוספתי שורה כפולה._`;
    case 'read-failed':
      return `😕 לא הצלחתי לקרוא את הקבלה.${detail ? `\n_${detail}_` : ''}\nנסה לשלוח אותה שוב.`;
    case 'sheet-failed':
      return `📊 קראתי את הקבלה, אבל הכתיבה לגיליון נכשלה.${detail ? `\n_${detail}_` : ''}\nהתמונה נשמרה — אפשר לשלוח שוב אחרי שזה יסתדר.`;
    default:
      return `😕 משהו השתבש.${detail ? `\n_${detail}_` : ''}`;
  }
}
