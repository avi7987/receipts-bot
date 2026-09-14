// =====================================================================
//  drive-status.js — מה להראות לעמית על כל קובץ שהעלה.
//
//  בלי צ'אט אין את מי לשאול ואין למי לענות. לכן כל קובץ בתיקייה
//  מופיע בלשונית "קליטה" בגיליון שלו, עם מצב וסיבה. הבדיקה נעשית
//  בעין: אם הקובץ בתיקייה — הוא ברשימה, ואם הוא לא נקלט — כתוב למה.
//
//  פונקציות טהורות בלבד, כדי שאפשר יהיה לבדוק אותן בלי רשת.
// =====================================================================

export const STATUS_TAB = 'קליטה';
export const STATUS_HEADERS = ['קובץ', 'הועלה', 'מצב', 'פרטים', 'עודכן'];

/** שגיאה טכנית → משפט שעמית מבין, והאם יש טעם לנסות שוב */
export function reasonOf(err) {
  const m = String(err?.message || err || '');

  if (m === 'missing-gemini-key') return { text: 'לא הוגדר מפתח AI', retryable: true };
  if (m === 'too-large') return { text: 'הקובץ גדול מדי (עד 8MB)', retryable: false };
  if (/Gemini 429/.test(m)) return { text: 'מכסת ה-AI היומית נגמרה — ינוסה שוב אוטומטית', retryable: true };
  if (/Gemini (400|401|403)/.test(m) && /API.?key|API_KEY|PERMISSION|permission|not valid/i.test(m)) {
    return { text: 'מפתח ה-AI לא תקין — צריך מפתח חדש', retryable: true };
  }
  if (/Gemini 5\d\d|fetch failed|timeout|aborted|ECONN|ENOTFOUND/i.test(m)) {
    return { text: 'תקלה זמנית בחיבור — ינוסה שוב', retryable: true };
  }
  if (m === 'bad-json' || /תשובה ריקה/.test(m)) return { text: 'הקריאה נכשלה — ינוסה שוב', retryable: true };
  if (/Sheets .*\b403\b/.test(m)) return { text: 'אין הרשאת עריכה לגיליון', retryable: true };
  if (/Sheets .*\b404\b/.test(m)) return { text: 'הגיליון לא נמצא', retryable: true };
  if (/Drive download 403|Drive list 403/.test(m)) return { text: 'אין גישה לקובץ בתיקייה', retryable: true };

  return { text: m.split('\n')[0].slice(0, 120) || 'שגיאה לא ידועה', retryable: true };
}

const STUCK_AFTER = 3;

function stateText(entry) {
  if (!entry) return '⏳ ממתין לקליטה';
  // כישלון שאין טעם לנסות שוב (למשל קובץ גדול מדי) נשמר ביומן כסגור,
  // אבל הוא לא "לא קבלה" — מציגים אותו כמו שהוא
  if (entry.retryable === false) return '⛔ לא ניתן לקלוט';
  switch (entry.status) {
    case 'done': return '✅ נקלטה';
    case 'duplicate': return '♻️ כבר קיימת בגיליון';
    case 'not-receipt': return '🤷 לא קבלה';
    case 'failed': return (entry.attempts || 0) >= STUCK_AFTER ? '⚠️ לא נקלטה' : '⏳ ינוסה שוב';
    default: return '⏳ בטיפול';
  }
}

function detailText(entry) {
  if (!entry) return '';
  if (entry.status === 'done') return [entry.label, entry.row ? `שורה ${entry.row}` : ''].filter(Boolean).join(' · ');
  if (entry.status === 'duplicate') return entry.row ? `שורה ${entry.row}` : '';
  return entry.reason || '';
}

const dt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
};

/**
 * שורות הלשונית: כל קובץ שנמצא עכשיו בתיקייה, מהחדש לישן.
 * @param {Array<{id,name,createdTime}>} files
 * @param {(id:string)=>object|null} entryOf
 */
export function statusRows(files, entryOf, { limit = 300 } = {}) {
  return [...files]
    .sort((a, b) => String(b.createdTime || '').localeCompare(String(a.createdTime || '')))
    .slice(0, limit)
    .map((f) => {
      const e = entryOf(f.id);
      return [f.name, dt(f.createdTime), stateText(e), detailText(e), dt(e?.updatedAt ? new Date(e.updatedAt).toISOString() : null)];
    });
}

/** טביעת אצבע — כדי לכתוב ללשונית רק כשמשהו השתנה */
export function fingerprint(rows) {
  // בלי עמודת "עודכן": היא משתנה בכל ניסיון חוזר גם כשהמצב זהה
  return JSON.stringify(rows.map((r) => r.slice(0, 4)));
}

/** סיומת קובץ לפי סוג, לקישור ההורדה */
export function extOf(mime, name = '') {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase();
  if (fromName) return fromName === 'jpeg' ? 'jpg' : fromName;
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' }[mime] || 'bin';
}
