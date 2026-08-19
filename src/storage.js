// =====================================================================
//  storage.js — שמירת תמונת הקבלה, כדי שבטבלה יהיה קישור אליה.
//
//  שלושה מצבים (STORAGE ב-.env):
//    supabase — מעלה ל-Supabase Storage ומחזיר קישור קבוע. מומלץ.
//    local    — שומר לתיקייה על המחשב. לא שורד הרצה בענן.
//    none     — לא שומר. בטבלה לא יהיה קישור.
//
//  בכל מקרה — התמונה המקורית נשארת גם בוואטסאפ עצמו. השמירה כאן היא
//  כדי שיהיה אפשר להגיע לקבלה מתוך הטבלה, בלי לחפש בצ'אט.
// =====================================================================
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const MODE = (process.env.STORAGE || 'local').toLowerCase();
const DIR = process.env.RECEIPTS_DIR || './receipts';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SB_BUCKET = process.env.SUPABASE_BUCKET || 'receipts';

export function storageMode() {
  if (MODE === 'supabase' && !(SB_URL && SB_KEY)) return 'none';
  return MODE;
}

// ── הגשה מהשרת עצמו ─────────────────────────────────────────────────
//
//  התמונות כבר יושבות על השרת, ולשרת יש כתובת ציבורית. במקום להוסיף
//  ספק אחסון חיצוני, מגישים אותן ישירות — עם שם קובץ שנגזר מתוכן
//  התמונה ומסוד מקומי, כך שאי אפשר לנחש כתובת של קבלה אחרת.
//
//  שם התצוגה נשמר בקובץ נלווה, כדי שההורדה תקבל שם קריא
//  (2026-08-19_קפה-גרציאני_60.jpg) ולא את המזהה האקראי.
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const LINK_SECRET = process.env.LINK_SECRET || '';

export function servingConfigured() {
  return !!(PUBLIC_BASE && LINK_SECRET);
}

/** מזהה יציב לכל תמונה — אותה תמונה תמיד תקבל אותו מזהה */
export function tokenFor(base64) {
  return crypto.createHash('sha256').update(LINK_SECRET + base64).digest('hex').slice(0, 32);
}

/**
 * שומר עותק להגשה ומחזיר { token, url }, או null.
 * לעולם לא זורק — כישלון כאן לא אמור להפיל קליטת קבלה.
 */
export function saveForServing(base64, mimetype, displayName) {
  if (!servingConfigured()) return null;
  try {
    const dir = path.resolve(DIR, 'public');
    fs.mkdirSync(dir, { recursive: true });

    const token = tokenFor(base64);
    const ext = EXT[String(mimetype).toLowerCase()] || 'bin';
    fs.writeFileSync(path.join(dir, `${token}.${ext}`), Buffer.from(base64, 'base64'));
    fs.writeFileSync(
      path.join(dir, `${token}.json`),
      JSON.stringify({ name: displayName, mime: mimetype, ext }),
    );

    return { token, url: `${PUBLIC_BASE}/r/${token}.${ext}` };
  } catch (e) {
    console.error('⚠️  שמירת עותק להגשה נכשלה:', e.message || e);
    return null;
  }
}

/** מאתר קובץ להגשה לפי המזהה שהתקבל בכתובת. */
export function resolveServed(fileName) {
  // רק מזהה בן 32 תווים הקסדצימליים עם סיומת מוכרת — שום נתיב אחר
  const m = /^([0-9a-f]{32})\.(jpg|png|webp|heic|heif|pdf)$/.exec(String(fileName || ''));
  if (!m) return null;

  const dir = path.resolve(DIR, 'public');
  const file = path.join(dir, `${m[1]}.${m[2]}`);
  if (!file.startsWith(dir) || !fs.existsSync(file)) return null;

  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, `${m[1]}.json`), 'utf8')); } catch { /* לא קריטי */ }

  return {
    path: file,
    size: fs.statSync(file).size,
    mime: meta.mime || 'application/octet-stream',
    name: meta.name || `${m[1]}.${m[2]}`,
  };
}

const EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'application/pdf': 'pdf',
};

/**
 * שומר את הקובץ ומחזיר קישור/נתיב, או null.
 * לעולם לא זורק — כישלון שמירה לא אמור להפיל את קליטת הקבלה.
 */
export async function saveReceipt(base64, mimetype, hint = {}) {
  const mode = storageMode();
  if (mode === 'none') return null;

  const name = fileName(mimetype, hint);
  try {
    return mode === 'supabase'
      ? await toSupabase(base64, mimetype, name)
      : toLocal(base64, name);
  } catch (e) {
    console.error('⚠️  שמירת התמונה נכשלה (הקבלה עצמה נקלטה בכל זאת):', e.message || e);
    return null;
  }
}

// ── Supabase Storage ────────────────────────────────────────────────
async function toSupabase(base64, mimetype, name) {
  const buf = Buffer.from(base64, 'base64');
  const res = await fetch(`${SB_URL}/storage/v1/object/${SB_BUCKET}/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': mimetype,
      'x-upsert': 'true',
    },
    body: buf,
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (res.status === 404 || /bucket/i.test(body)) {
      throw new Error(`הדלי "${SB_BUCKET}" לא קיים ב-Supabase Storage. צור אותו (ציבורי) ונסה שוב.`);
    }
    throw new Error(`Supabase upload ${res.status}: ${body}`);
  }
  return `${SB_URL}/storage/v1/object/public/${SB_BUCKET}/${encodeURIComponent(name)}`;
}

// ── תיקייה מקומית ───────────────────────────────────────────────────
function toLocal(base64, name) {
  fs.mkdirSync(DIR, { recursive: true });
  const full = path.resolve(DIR, name);
  fs.writeFileSync(full, Buffer.from(base64, 'base64'));
  return full;
}

// ── שם קובץ קריא: 2026-08-06_רמי-לוי_87.40.jpg ──────────────────────
function fileName(mimetype, { date, vendor, total, id } = {}) {
  const ext = EXT[String(mimetype).toLowerCase()] || 'bin';
  const day = date || new Date().toISOString().slice(0, 10);
  const who = vendor ? `_${safe(vendor)}` : '';
  const amount = total !== null && total !== undefined ? `_${total}` : '';
  const uniq = id ? `_${String(id).replace(/\W/g, '').slice(-6)}` : `_${Date.now().toString(36)}`;
  return `${day}${who}${amount}${uniq}.${ext}`;
}

// שומר עברית ואנגלית, מוריד כל מה שעלול לשבור נתיב או URL
function safe(s) {
  return String(s).trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40);
}
