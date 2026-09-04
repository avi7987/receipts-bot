// =====================================================================
//  ledger.js — מה קרה לכל קבלה, ומה עוד לא קרה.
//
//  הקובץ הקודם (processed.json) זכר רק מה שהצליח. זה הספיק כדי לא
//  לקלוט פעמיים, אבל זה השאיר את הכשל הגרוע ביותר בלי מענה: קבלה
//  שנשלחה, לא נקלטה, ואף אחד לא ידע. במיוחד כשהבוט רץ על מחשב
//  שנכבה בערב — ההודעה מגיעה כשאף אחד לא מקשיב.
//
//  כאן נרשמת כל תמונה שראינו, גם זו שנכשלה, עם הסיבה ועם מתי לנסות
//  שוב. מה שאפשר לתקן לבד — ינוסה שוב לבד. מה שלא — ייאמר בקול.
//
//  מקור אמת אחד: היומן הזה מחליף את processed.json ולא חי לצידו.
//  שני זיכרונות שחלוקים זה על זה כבר עלו לנו פעם בקבלה שנחסמה
//  כ"כפולה" אחרי שהשורה שלה נמחקה מהגיליון.
// =====================================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const OLD_FILE = path.resolve(process.env.STATE_PATH || './.state/processed.json');

//  היומן יושב ליד הקובץ הישן, ולא בנתיב משלו. בשרת התיקייה הזו
//  ממופה החוצה מהקונטיינר; משתנה סביבה חדש היה נשאר לא מוגדר שם,
//  היומן היה נכתב לתוך הקונטיינר, וכל פריסה הייתה מוחקת אותו —
//  והבוט היה סורק את ההיסטוריה מחדש ושורף את מכסת ה-AI היומית.
const FILE = process.env.LEDGER_PATH
  ? path.resolve(process.env.LEDGER_PATH)
  : path.join(path.dirname(OLD_FILE), 'ledger.json');
const MAX = 2000;

// ── מצבים ───────────────────────────────────────────────────────────
export const DONE = 'done';            // נכתבה שורה
export const DUPLICATE = 'duplicate';  // כבר קיימת בגיליון
export const NOT_RECEIPT = 'not-receipt';
export const FAILED = 'failed';        // נכשל — ראה retryAt
export const PENDING = 'pending';      // ראינו, עוד לא טופל

/** מצבים שמבחינת המשתמש "סגורים" — אין מה לעשות איתם */
const SETTLED = new Set([DONE, DUPLICATE, NOT_RECEIPT]);

export function isSettled(status) {
  return SETTLED.has(status);
}

let mem = { version: 1, entries: {} };
let loaded = false;

// ── טעינה והגירה ────────────────────────────────────────────────────
function load() {
  if (loaded) return mem;
  loaded = true;

  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && typeof j.entries === 'object') {
      mem = { version: 1, entries: j.entries };
      return mem;
    }
  } catch { /* אין יומן — ננסה להגר */ }

  migrateFromProcessed();
  return mem;
}

//  ההגירה חשובה: בלעדיה העלייה הראשונה הייתה מתייחסת לכל ההיסטוריה
//  כלא־מטופלת ושורפת את מכסת ה-AI היומית על קבלות שכבר בגיליון.
function migrateFromProcessed() {
  let old;
  try {
    old = JSON.parse(fs.readFileSync(OLD_FILE, 'utf8'));
  } catch {
    return;
  }

  const entries = {};
  for (const id of Array.isArray(old.msgIds) ? old.msgIds : []) {
    if (!id) continue;
    entries[id] = { id, status: DONE, migrated: true };
  }
  for (const [hash, info] of Object.entries(old.hashes || {})) {
    const label = typeof info === 'object' ? info.label : null;
    const row = typeof info === 'object' ? info.row : null;
    // רשומה לפי טביעת אצבע, למקרה שאין לנו את מזהה ההודעה
    entries[`hash:${hash}`] = { id: `hash:${hash}`, hash, status: DONE, label, row, migrated: true };
  }

  mem = { version: 1, entries };
  save();
  const n = Object.keys(entries).length;
  if (n) console.log(`📒 יומן: הוגרו ${n} רשומות מ-processed.json`);
}

function save() {
  try {
    const keys = Object.keys(mem.entries);
    if (keys.length > MAX) {
      // מוחקים את הישנות, אבל אף פעם לא רשומה שעוד לא נסגרה
      const byAge = keys
        .filter((k) => isSettled(mem.entries[k]?.status))
        .sort((a, b) => (mem.entries[a].at || 0) - (mem.entries[b].at || 0));
      for (const k of byAge.slice(0, keys.length - MAX)) delete mem.entries[k];
    }
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(mem));
  } catch (e) {
    console.error('⚠️  שמירת היומן נכשלה:', e.message || e);
  }
}

export function hashOf(base64) {
  return crypto.createHash('sha256').update(base64).digest('hex').slice(0, 32);
}

// ── קריאה ───────────────────────────────────────────────────────────
export function get(id) {
  return load().entries[id] || null;
}

/** האם ההודעה כבר טופלה עד הסוף (ולכן אין לגעת בה שוב) */
export function settled(id) {
  const e = get(id);
  return !!e && isSettled(e.status);
}

/** רשומה קודמת לאותה תמונה בדיוק, לפי תוכן הקובץ */
export function byHash(hash) {
  if (!hash) return null;
  const all = load().entries;
  if (all[`hash:${hash}`]) return all[`hash:${hash}`];
  return Object.values(all).find((e) => e.hash === hash) || null;
}

export function all() {
  return Object.values(load().entries);
}

/** מה שעוד לא נסגר — זה מה שצריך לצעוק עליו */
export function open() {
  return all().filter((e) => !isSettled(e.status) && !String(e.id).startsWith('hash:'));
}

/** מה שמוכן לניסיון חוזר עכשיו */
export function dueForRetry(now = Date.now()) {
  return open().filter((e) => !e.retryAt || e.retryAt <= now);
}

// ── כתיבה ───────────────────────────────────────────────────────────
/** רושם שראינו תמונה, עוד לפני שניסינו לטפל בה */
export function noticed(id, { chat = null, at = null } = {}) {
  const s = load();
  if (!id) return null;
  if (s.entries[id]) return s.entries[id];
  s.entries[id] = { id, chat, at, seenAt: Date.now(), status: PENDING, attempts: 0 };
  save();
  return s.entries[id];
}

export function mark(id, status, extra = {}) {
  const s = load();
  if (!id) return null;
  const prev = s.entries[id] || { id, seenAt: Date.now(), attempts: 0 };
  s.entries[id] = { ...prev, ...extra, status, at: extra.at ?? prev.at, updatedAt: Date.now() };
  save();
  return s.entries[id];
}

//  השהיה גדלה בהדרגה, אבל תקרה של שעה: כשהמכסה היומית נגמרת אין
//  טעם לנסות כל דקה, וכשזו תקלת רשת חולפת אין טעם לחכות יום.
const BACKOFF = [60e3, 5 * 60e3, 20 * 60e3, 60 * 60e3];

export function failed(id, reason, { retryable = true, extra = {} } = {}) {
  const prev = get(id);
  const attempts = (prev?.attempts || 0) + 1;
  const retryAt = retryable ? Date.now() + BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)] : null;
  return mark(id, retryable ? FAILED : NOT_RECEIPT, {
    ...extra, reason: String(reason || '').slice(0, 300), attempts, retryable, retryAt,
  });
}

/** מאפשר לטפל מחדש בהודעה — למשל אחרי שמחקת את השורה מהגיליון */
export function forget(id) {
  const s = load();
  if (!s.entries[id]) return false;
  delete s.entries[id];
  save();
  return true;
}

export function forgetHash(hash) {
  const e = byHash(hash);
  return e ? forget(e.id) : false;
}

// ── סיכום למשתמש ────────────────────────────────────────────────────
/**
 * @returns {{done:number, failed:number, pending:number, notReceipt:number,
 *            duplicate:number, oldestOpen:object|null}}
 */
export function summary() {
  const list = all().filter((e) => !e.migrated);
  const count = (st) => list.filter((e) => e.status === st).length;
  const openOnes = open().sort((a, b) => (a.seenAt || 0) - (b.seenAt || 0));
  return {
    done: count(DONE),
    duplicate: count(DUPLICATE),
    notReceipt: count(NOT_RECEIPT),
    failed: count(FAILED),
    pending: count(PENDING),
    oldestOpen: openOnes[0] || null,
  };
}

export const LEDGER_FILE = FILE;
