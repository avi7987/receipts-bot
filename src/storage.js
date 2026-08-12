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

const MODE = (process.env.STORAGE || 'local').toLowerCase();
const DIR = process.env.RECEIPTS_DIR || './receipts';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SB_BUCKET = process.env.SUPABASE_BUCKET || 'receipts';

export function storageMode() {
  if (MODE === 'supabase' && !(SB_URL && SB_KEY)) return 'none';
  return MODE;
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
