// =====================================================================
//  state.js — זיכרון קצר של "מה כבר טופל".
//
//  שתי מטרות:
//   1. אחרי הפעלה מחדש, וואטסאפ מסנכרן הודעות ישנות — בלי זה כל קבלה
//      הייתה נקלטת שוב.
//   2. אם שולחים בטעות את אותה תמונה פעמיים, זה נתפס לפי תוכן הקובץ
//      ולא נכתבת שורה כפולה.
//
//  קובץ JSON פשוט. אין כאן שום דבר רגיש — רק מזהי הודעות וטביעות אצבע.
// =====================================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const FILE = path.resolve(process.env.STATE_PATH || './.state/processed.json');
const MAX = 800;   // כמה רשומות לשמור לפני שמוחקים את הישנות

let mem = { msgIds: [], hashes: {} };
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const j = JSON.parse(raw);
    mem = {
      msgIds: Array.isArray(j.msgIds) ? j.msgIds : [],
      hashes: j.hashes && typeof j.hashes === 'object' ? j.hashes : {},
    };
  } catch {
    // אין קובץ עדיין — מתחילים נקי
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(mem));
  } catch (e) {
    console.error('⚠️  שמירת הזיכרון נכשלה:', e.message || e);
  }
}

export function hashOf(base64) {
  return crypto.createHash('sha256').update(base64).digest('hex').slice(0, 32);
}

export function seenMessage(id) {
  load();
  return !!id && mem.msgIds.includes(id);
}

/** אם התמונה כבר נקלטה — מחזיר את התיאור של הפעם הקודמת, אחרת null. */
export function seenImage(hash) {
  load();
  return mem.hashes[hash] || null;
}

export function remember(id, hash, info) {
  load();
  if (id) {
    mem.msgIds.push(id);
    if (mem.msgIds.length > MAX) mem.msgIds = mem.msgIds.slice(-MAX);
  }
  if (hash) {
    mem.hashes[hash] = info || true;
    const keys = Object.keys(mem.hashes);
    if (keys.length > MAX) {
      for (const k of keys.slice(0, keys.length - MAX)) delete mem.hashes[k];
    }
  }
  save();
}

/** מסמן הודעה כמטופלת בלי לרשום טביעת אצבע (למשל: תמונה שאינה קבלה). */
export function rememberMessage(id) {
  remember(id, null, null);
}
