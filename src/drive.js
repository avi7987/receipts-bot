// =====================================================================
//  drive.js — העלאת תמונת הקבלה ל-Google Drive.
//
//  התיקייה שייכת לך, ורק משותפת עם חשבון השירות. לכן הקבצים
//  נספרים על מקום האחסון שלך, אתה רואה אותם ב-Drive רגיל, וגם אם
//  חשבון השירות יימחק יום אחד — הקבצים נשארים אצלך.
//
//  הקישור שנשמר בטבלה הוא קישור הורדה ישירה: לחיצה מורידה את
//  הקובץ למחשב במקום לפתוח מסך תצוגה של Drive. זו בדיוק הפעולה
//  שצריך לפני העלאה לאתר ההחזרים.
// =====================================================================
import 'dotenv/config';
import crypto from 'crypto';

const FOLDER = (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
const SA_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

export function driveConfigured() {
  return !!(FOLDER && SA_EMAIL && SA_KEY);
}

/** קישור שמוריד את הקובץ ישירות, בלי מסך ביניים */
export function downloadUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

// ── העלאה ───────────────────────────────────────────────────────────
/**
 * מעלה קובץ ומחזיר { id, url }, או null אם לא מוגדר / נכשל.
 * לעולם לא זורק — כישלון העלאה לא אמור להפיל קליטת קבלה.
 */
export async function uploadReceipt(base64, mimetype, filename) {
  if (!driveConfigured()) return null;

  try {
    const token = await accessToken();
    const boundary = `----receipts${Date.now()}`;
    const meta = JSON.stringify({ name: filename, parents: [FOLDER] });

    // multipart: חלק אחד מטא-דאטה, חלק שני הקובץ עצמו
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimetype}\r\n\r\n`),
      Buffer.from(base64, 'base64'),
      Buffer.from(`\r\n--${boundary}--`),
    ]);

    const res = await fetch(`${UPLOAD}?uploadType=multipart&fields=id&supportsAllDrives=true`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const t = (await res.text()).slice(0, 250);
      console.error(`⚠️  העלאה ל-Drive נכשלה (${res.status}): ${t}`);
      if (/has not been used|accessNotConfigured/i.test(t)) {
        console.error('   → צריך להפעיל Google Drive API ב-Cloud Console');
      } else if (res.status === 404) {
        console.error('   → התיקייה לא משותפת עם חשבון השירות, או שהמזהה שגוי');
      }
      return null;
    }

    const { id } = await res.json();
    return id ? { id, url: downloadUrl(id) } : null;
  } catch (e) {
    console.error('⚠️  העלאה ל-Drive נכשלה:', e.message || e);
    return null;
  }
}

// ── אימות (אותו חשבון שירות של הגיליון) ─────────────────────────────
let cached = null;

async function accessToken() {
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64(JSON.stringify({
    iss: SA_EMAIL, scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64(signer.sign(SA_KEY))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(20000),
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Google auth ${res.status}`);

  const data = await res.json();
  if (!data.access_token) throw new Error('לא התקבל access_token');
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return cached.token;
}
