// =====================================================================
//  drive.js — קריאת קבלות מתיקייה ב-Google Drive.
//
//  למה דרייב ולא וואטסאפ: כדי לתת את הכלי לעוד אנשים בלי לקשר את
//  חשבון הוואטסאפ שלהם לשרת. מכשיר מקושר רואה את כל השיחות שלהם
//  ומסכן את החשבון בחסימה; תיקייה משותפת חושפת בדיוק תיקייה אחת.
//
//  חשבון השירות יכול *לקרוא* מה ששיתפו איתו, אבל לא ליצור שם קבצים —
//  ניסיון יצירה מחזיר 403 "storage quota exceeded" גם בתוך תיקייה
//  משותפת, כי הקובץ היה נרשם על שמו והוא בלי נפח. לכן כל אחד יוצר
//  את התיקייה ואת הגיליון בעצמו ומשתף אותם.
//
//  הרשאה מבוקשת: קריאה בלבד. לקלוט קבלות לא דורש למחוק אותן.
// =====================================================================
import 'dotenv/config';
import crypto from 'crypto';

const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
const SA_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const API = 'https://www.googleapis.com/drive/v3';

export function driveConfigured() {
  return !!(SA_EMAIL && SA_KEY);
}

// ── אימות ───────────────────────────────────────────────────────────
//  טוקן נפרד לכל הרשאה: לדרייב מבקשים קריאה בלבד, ולגיליון — עריכה.
//  טוקן אחד רחב לשניהם היה נותן לקוד הדרייב יכולת למחוק קבצים.
const cache = new Map();

const b64 = (s) => Buffer.from(s).toString('base64url');

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export function accessToken() {
  return tokenFor(SCOPE);
}

export async function tokenFor(scope) {
  const hit = cache.get(scope);
  if (hit && Date.now() < hit.until) return hit.token;
  if (!driveConfigured()) throw new Error('drive-not-configured');

  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64(JSON.stringify({
    iss: SA_EMAIL, scope,
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sg = crypto.createSign('RSA-SHA256');
  sg.update(`${head}.${claim}`);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(20000),
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claim}.${b64(sg.sign(SA_KEY))}`,
    }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`אימות דרייב נכשל: ${JSON.stringify(j).slice(0, 200)}`);

  cache.set(scope, { token: j.access_token, until: Date.now() + (j.expires_in - 120) * 1000 });
  return j.access_token;
}

// ── חיפוש הגיליון בתוך התיקייה ───────────────────────────────────────
//  כך העמית לא צריך לשלוח שני קישורים: הוא יוצר גיליון בתוך התיקייה,
//  וההרשאה על התיקייה עוברת אליו בירושה.
export async function spreadsheetsIn(folderId) {
  const token = await accessToken();
  const url = new URL(`${API}/files`);
  url.searchParams.set('q', `'${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.spreadsheet'`);
  url.searchParams.set('fields', 'files(id,name,capabilities(canEdit))');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Drive list ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).files || [];
}

/** פרטי קובץ, כולל התיקייה שהוא יושב בה */
export async function fileMeta(fileId) {
  const token = await accessToken();
  const res = await fetch(`${API}/files/${fileId}?fields=id,name,mimeType,size,parents,trashed`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Drive meta ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** פותח קובץ להזרמה — בשביל קישור ההורדה בגיליון ובסימנייה */
export async function openFile(fileId) {
  const token = await accessToken();
  const res = await fetch(`${API}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Drive download ${res.status}`);
  return res;
}

// ── התיקייה ─────────────────────────────────────────────────────────
/**
 * מוודא שהתיקייה נגישה, ומחזיר את שמה.
 * חשוב: רשימה ריקה אינה מעידה על היעדר גישה — דרייב מחזיר 200 עם
 * אפס קבצים גם כשאין הרשאה. הבדיקה היחידה שמבדילה היא הקריאה הזו.
 */
export async function folderInfo(folderId) {
  const token = await accessToken();
  const res = await fetch(
    `${API}/files/${folderId}?fields=id,name,mimeType,capabilities(canListChildren,canDownload)`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) },
  );
  if (res.status === 404) throw new Error('folder-not-shared');
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const j = await res.json();
  if (j.mimeType !== 'application/vnd.google-apps.folder') throw new Error('not-a-folder');
  if (!j.capabilities?.canListChildren) throw new Error('folder-not-readable');
  return { id: j.id, name: j.name };
}

const KINDS = "(mimeType contains 'image/' or mimeType = 'application/pdf')";

/**
 * הקבצים שאפשר לקרוא כקבלה, מהישן לחדש — כדי שהשורות ייכתבו
 * בסדר כרונולוגי גם בקליטה ראשונה של תיקייה מלאה.
 * @returns {Promise<Array<{id,name,mimeType,size,createdTime}>>}
 */
export async function listReceipts(folderId, { limit = 100 } = {}) {
  const token = await accessToken();
  const q = `'${folderId}' in parents and trashed=false and ${KINDS}`;

  const out = [];
  let pageToken = null;
  do {
    const url = new URL(`${API}/files`);
    url.searchParams.set('q', q);
    url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime)');
    url.searchParams.set('orderBy', 'createdTime');
    url.searchParams.set('pageSize', String(Math.min(100, limit)));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Drive list ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const j = await res.json();
    out.push(...(j.files || []));
    pageToken = j.nextPageToken || null;
  } while (pageToken && out.length < limit);

  return out.slice(0, limit);
}

// ── הורדה ───────────────────────────────────────────────────────────
const MAX_BYTES = Number(process.env.MAX_RECEIPT_BYTES || 8 * 1024 * 1024);

/**
 * מוריד קובץ ומחזיר { base64, mimetype, bytes, filename }.
 * אותה צורה שמחזירה ההורדה מוואטסאפ, כדי ששאר הקוד לא ידע מאיפה
 * הקבלה הגיעה.
 */
export async function download(file) {
  const token = await accessToken();

  if (file.size && Number(file.size) > MAX_BYTES) throw new Error('too-large');

  const res = await fetch(`${API}/files/${file.id}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Drive download ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('too-large');
  // גודל שלא תואם מעיד על הורדה חלקית — עדיף להיכשל מאשר לקרוא חצי קבלה
  if (file.size && String(buf.length) !== String(file.size)) {
    throw new Error(`הורדה חלקית: ${buf.length} מתוך ${file.size}`);
  }

  return {
    base64: buf.toString('base64'),
    mimetype: file.mimeType,
    bytes: buf.length,
    filename: file.name,
  };
}
