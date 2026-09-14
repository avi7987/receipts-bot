// =====================================================================
//  onboard.js — רישום עמית: הבדיקות, השמירה והסימנייה.
//
//  משותף לדף ההרשמה העצמית (/join) ולכלי הניהול (colleague add).
//  אותן בדיקות בשני המסלולים — כדי שאין דרך "קלה יותר" להירשם
//  שמדלגת על משהו.
//
//  סדר הבדיקות מכוון: קודם מה שחינמי ומהיר (תיקייה, גיליון), ורק אז
//  קריאה אמיתית ל-AI, שעולה לעמית קריאה אחת מהמכסה שלו.
// =====================================================================
import * as C from './colleagues.js';
import { folderInfo, spreadsheetsIn } from './drive.js';
import { runWorker } from './drive-runner.js';
import { buildBookmarklet } from './bookmarklet.js';

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const MAX = () => Math.max(1, Number(process.env.MAX_COLLEAGUES || 40));

export class OnboardError extends Error {
  /** @param {string} field  השדה בטופס שהשגיאה שייכת לו: name | folder | key | general */
  constructor(message, field = 'general') {
    super(message);
    this.field = field;
  }
}

const sheetUrl = (id) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

// ── מפתח AI: קריאה אמיתית ───────────────────────────────────────────
export async function checkKey(key) {
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ contents: [{ parts: [{ text: 'ok' }] }], generationConfig: { maxOutputTokens: 256 } }),
    });
  } catch {
    return { ok: false, transient: true, error: 'לא הצלחתי לבדוק את המפתח כרגע — נסה שוב בעוד דקה' };
  }
  if (res.ok) return { ok: true };
  // מכסה שנגמרה פירושה שהמפתח עצמו תקין
  if (res.status === 429) return { ok: true, warning: 'המפתח תקין, אבל המכסה היומית שלו נגמרה. הקבלות ייקלטו כשהיא תתאפס.' };
  if ([400, 401, 403].includes(res.status)) return { ok: false, error: 'המפתח לא תקין או לא פעיל. בדוק שהעתקת אותו במלואו.' };
  if (res.status === 404) return { ok: false, error: `המודל ${MODEL()} לא זמין למפתח הזה` };
  return { ok: false, transient: true, error: `בדיקת המפתח נכשלה (${res.status}) — נסה שוב` };
}

export function cleanName(input) {
  return String(input || '').replace(/[<>"`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function bookmarkletFor(c) {
  const { text, version } = buildBookmarklet({
    api: process.env.PUBLIC_BASE_URL || '',
    key: C.pendingKeyOf(c.secret),
  });
  return { text, version };
}

// ── רישום ───────────────────────────────────────────────────────────
//  רישומים רצים אחד-אחד: שניים במקביל היו קוראים את הרשימה, כל אחד
//  מוסיף את עצמו, והשני דורס את הראשון.
let queue = Promise.resolve();

export function register(input) {
  const run = queue.then(() => doRegister(input));
  queue = run.catch(() => {});
  return run;
}

async function doRegister({ name, folder, key, onStep = () => {} }) {
  name = cleanName(name);
  const folderId = C.folderIdFrom(folder);
  key = String(key || '').trim().split(/\s+/)[0] || '';

  if (!name) throw new OnboardError('צריך שם', 'name');
  if (!folderId) throw new OnboardError('זה לא נראה כמו קישור לתיקייה בדרייב. פתח את התיקייה והעתק את הכתובת מהדפדפן.', 'folder');
  if (!key) throw new OnboardError('צריך מפתח AI', 'key');
  if (!/^[A-Za-z0-9._-]{30,}$/.test(key)) throw new OnboardError('זה לא נראה כמו מפתח AI. הוא מתחיל בדרך כלל ב-AIza או ב-AQ.', 'key');
  if (!String(process.env.PUBLIC_BASE_URL || '').startsWith('https://')) {
    throw new OnboardError('השירות לא מוגדר עד הסוף (PUBLIC_BASE_URL)');
  }

  const all = C.list();
  const hash = C.keyHash(key);
  if (process.env.OWNER_KEY_HASH && hash === process.env.OWNER_KEY_HASH) {
    throw new OnboardError('את המפתח הזה אי אפשר להשתמש כאן. צור מפתח כשאתה מחובר לחשבון הגוגל שלך.', 'key');
  }

  // ── תיקייה שכבר רשומה: שחזור סימנייה או החלפת מפתח ──
  const existing = all.find((c) => c.folderId === folderId);
  if (existing) {
    if (existing.active === false) throw new OnboardError('הרישום של התיקייה הזו מושהה. פנה למפעיל השירות.', 'folder');

    // אותו מפתח = אותו אדם. מחזירים את הסימנייה, בלי ליצור רישום כפול.
    if (C.keyHash(existing.geminiKey) === hash) {
      return { status: 'recovered', colleague: existing, sheetUrl: sheetUrl(existing.sheetId), bookmarklet: bookmarkletFor(existing) };
    }

    // מפתח אחר: מותר רק אם הישן כבר לא עובד. כך מי שמחליף מפתח
    // (למשל כי הישן בוטל) מסתדר לבד — ומי שרק מכיר את קישור התיקייה
    // לא יכול להשתלט על רישום פעיל של מישהו אחר.
    onStep('key');
    const oldKey = await checkKey(existing.geminiKey);
    if (oldKey.ok || oldKey.transient) {
      throw new OnboardError('התיקייה כבר רשומה עם מפתח אחר שעדיין עובד. אם החלפת מפתח — מחק את הישן ב-AI Studio ונסה שוב.', 'key');
    }
    await assertKeyUsable(key, hash, all.filter((c) => c.id !== existing.id));
    const updated = { ...existing, geminiKey: key, updatedAt: new Date().toISOString() };
    C.save(C.list().map((c) => (c.id === existing.id ? updated : c)));
    return { status: 'updated', colleague: updated, sheetUrl: sheetUrl(updated.sheetId), bookmarklet: bookmarkletFor(updated) };
  }

  if (all.length >= MAX()) throw new OnboardError('השירות מלא כרגע. פנה למפעיל השירות.');

  // ── תיקייה ──
  onStep('folder');
  let info;
  try {
    info = await folderInfo(folderId);
  } catch (e) {
    const why = {
      'folder-not-shared': `התיקייה לא משותפת עם השירות. שתף אותה עם ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL} בהרשאת עורך.`,
      'not-a-folder': 'הקישור הוא לקובץ, לא לתיקייה.',
      'folder-not-readable': 'התיקייה משותפת, אבל בלי הרשאה לקרוא בה. שנה את השיתוף ל"עורך".',
    }[e.message];
    throw new OnboardError(why || 'לא הצלחתי לגשת לתיקייה — נסה שוב בעוד דקה', 'folder');
  }

  // ── הגיליון שבתוכה ──
  onStep('sheet');
  const sheets = await spreadsheetsIn(folderId);
  if (!sheets.length) throw new OnboardError('אין גיליון בתוך התיקייה. צור בה Google Sheets ריק (חדש ← Google Sheets) ונסה שוב.', 'folder');
  if (sheets.length > 1) throw new OnboardError(`יש ${sheets.length} גיליונות בתיקייה. השאר בה רק אחד.`, 'folder');
  const [sheet] = sheets;
  if (sheet.capabilities?.canEdit === false) throw new OnboardError('לשירות יש הרשאת צפייה בלבד. שנה את השיתוף של התיקייה ל"עורך".', 'folder');

  // ── מפתח ──
  onStep('key');
  const keyCheck = await assertKeyUsable(key, hash, all);

  // ── שמירה והכנת הגיליון ──
  onStep('setup');
  const c = {
    id: C.newId(),
    name,
    folderId,
    folderName: info.name,
    sheetId: sheet.id,
    sheetName: sheet.name,
    geminiKey: key,
    secret: C.newSecret(),
    active: true,
    createdAt: new Date().toISOString(),
  };
  C.save([...C.list(), c]);

  const r = await runWorker(c, 'setup', { timeoutMs: 120e3 });
  if (!r.ok) {
    // לא משאירים רישום חצי־עובד
    C.save(C.list().filter((x) => x.id !== c.id));
    const why = /\b403\b/.test(r.error) ? 'אין לשירות הרשאת עריכה לגיליון. ודא שהשיתוף הוא "עורך".' : `הכנת הגיליון נכשלה: ${r.error}`;
    throw new OnboardError(why, 'folder');
  }

  return {
    status: 'created',
    colleague: c,
    sheetUrl: sheetUrl(c.sheetId),
    bookmarklet: bookmarkletFor(c),
    warning: keyCheck.warning || null,
  };
}

async function assertKeyUsable(key, hash, others) {
  const twin = others.find((c) => C.keyHash(c.geminiKey) === hash);
  if (twin) throw new OnboardError('המפתח הזה כבר רשום לתיקייה אחרת. לכל תיקייה צריך מפתח משלה.', 'key');
  const check = await checkKey(key);
  if (!check.ok) throw new OnboardError(check.error, 'key');
  return check;
}

// ── הגבלת קצב לדף ההרשמה ────────────────────────────────────────────
//  טהור ובלי רשת, כדי שאפשר לבדוק אותו. מחזיר true אם מותר לנסות.
export function makeLimiter({ perIp = 6, perIpWindowMs = 15 * 60e3, global = 60, globalWindowMs = 60 * 60e3 } = {}) {
  const hits = new Map();
  let all = [];
  return function allow(ip, now = Date.now()) {
    all = all.filter((t) => now - t < globalWindowMs);
    const mine = (hits.get(ip) || []).filter((t) => now - t < perIpWindowMs);
    if (mine.length >= perIp || all.length >= global) {
      hits.set(ip, mine);
      return false;
    }
    mine.push(now);
    all.push(now);
    hits.set(ip, mine);
    if (hits.size > 5000) hits.clear();   // לא נותנים לטבלה לגדול בלי סוף
    return true;
  };
}
