// =====================================================================
//  colleagues.js — מי משתמש בשירות הדרייב, ועם מה.
//
//  לכל עמית: תיקייה, גיליון, מפתח AI משלו, וסוד משלו. הסוד הוא
//  מקור המפתח של הסימנייה ושל חתימות הקבצים, כך ששני עמיתים לא
//  חולקים שום דבר שמאפשר לאחד לגעת בנתונים של השני.
//
//  הקובץ מכיל מפתחות של אנשים אחרים: נכתב בהרשאות 600, מחוץ ל-git.
// =====================================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const DATA_DIR = path.resolve(process.env.DRIVE_DATA_DIR || './data');
const FILE = path.join(DATA_DIR, 'colleagues.json');

export function tenantDir(id) {
  if (!/^[a-z0-9-]{3,40}$/.test(String(id))) throw new Error(`מזהה לא תקין: ${id}`);
  return path.join(DATA_DIR, 'tenants', id);
}

// ── מפתחות ──────────────────────────────────────────────────────────
/** המפתח שהסימנייה של העמית נושאת */
export function pendingKeyOf(secret) {
  return crypto.createHash('sha256').update(`${secret}:pending`).digest('hex').slice(0, 32);
}

/** חתימה לקובץ: קישור לקבלה עובד רק לקובץ שנחתם בסוד של אותו עמית */
export function fileSig(secret, fileId) {
  return crypto.createHmac('sha256', String(secret)).update(String(fileId)).digest('hex').slice(0, 24);
}

export function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

export function keyHash(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey || '').trim()).digest('hex');
}

// ── הרישום ──────────────────────────────────────────────────────────
export function list() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(j.colleagues) ? j.colleagues : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    // קובץ פגום זו סיבה לעצור, לא להמשיך בלי עמיתים ולהתעלם מכולם
    throw new Error(`colleagues.json לא קריא: ${e.message}`);
  }
}

export function active() {
  return list().filter((c) => c.active !== false);
}

export function save(colleagues) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, colleagues }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);   // כתיבה אטומית — קריסה באמצע לא תשאיר קובץ חצוי
  try { fs.chmodSync(FILE, 0o600); } catch { /* ווינדוס */ }
}

export function byId(id) {
  return list().find((c) => c.id === id) || null;
}

export function byPendingKey(key) {
  if (!key) return null;
  return active().find((c) => sameSecret(pendingKeyOf(c.secret), key)) || null;
}

export function newId() {
  return `c-${crypto.randomBytes(4).toString('hex')}`;
}

export function newSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/** מזהה תיקייה מתוך קישור או מזהה נקי */
export function folderIdFrom(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : null;
}
