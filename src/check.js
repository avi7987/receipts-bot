// =====================================================================
//  check.js — בדיקה שהכול מחובר, לפני שמפעילים את הבוט.
//
//  הרצה:  npm run check
//
//  בודק שלושה דברים בנפרד ואומר בדיוק מה חסר ואיך לתקן:
//    1. מפתח ה-AI — קריאה אמיתית ל-Gemini
//    2. הגיליון   — התחברות, יצירת הלשונית, כותרות, תיבות סימון
//    3. הקבוצה    — האם הוגדרה (החיבור עצמו נבדק בהרצה)
// =====================================================================
import 'dotenv/config';
import { visionAvailable } from './vision.js';
import { setupSheet, sheetsConfigured } from './sheets.js';

let failures = 0;

function ok(msg) { console.log(`  ✅ ${msg}`); }
function bad(msg, fix) {
  failures++;
  console.log(`  ❌ ${msg}`);
  if (fix) console.log(`     ↳ ${fix}`);
}

// ── 1. AI ───────────────────────────────────────────────────────────
console.log('\n1️⃣  מפתח ה-AI');
if (!visionAvailable()) {
  bad('אין GEMINI_API_KEY בקובץ .env', 'קח מפתח חינמי מ-https://aistudio.google.com/apikey');
} else {
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'החזר בדיוק: תקין' }] }] }),
    });
    if (res.ok) {
      ok(`המפתח עובד, מודל ${model}`);
    } else {
      const body = await res.text();
      if (res.status === 404) {
        bad(`המודל ${model} לא זמין למפתח הזה`, 'נסה GEMINI_MODEL=gemini-3.6-flash או gemini-flash-latest');
      } else if (res.status === 400 || res.status === 403) {
        bad(`המפתח נדחה (${res.status})`, 'ודא שהעתקת את המפתח במלואו, בלי רווחים');
      } else {
        bad(`שגיאה ${res.status}`, body.slice(0, 160));
      }
    }
  } catch (e) {
    bad('לא הצלחתי להגיע ל-Google', e.message);
  }
}

// ── 2. הגיליון ──────────────────────────────────────────────────────
console.log('\n2️⃣  הגיליון');
if (!sheetsConfigured()) {
  const missing = [
    !process.env.GOOGLE_SHEET_ID && 'GOOGLE_SHEET_ID',
    !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && 'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    !process.env.GOOGLE_PRIVATE_KEY && 'GOOGLE_PRIVATE_KEY',
  ].filter(Boolean);
  bad(`חסר ב-.env: ${missing.join(', ')}`, 'הרץ  npm run link-google  כדי למלא אוטומטית מקובץ ה-JSON');
} else {
  try {
    const r = await setupSheet();
    ok(`מחובר. הלשונית "${r.tab}" מוכנה, עם תיבות סימון וצביעה.`);
    console.log(`     ${r.url}`);
  } catch (e) {
    const m = e.message || '';
    if (m.includes('403')) {
      bad('אין הרשאה לגיליון', `שתף את הגיליון עם ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL} בהרשאת "עורך"`);
    } else if (m.includes('404')) {
      bad('הגיליון לא נמצא', 'בדוק את GOOGLE_SHEET_ID — הוא החלק שאחרי /d/ בכתובת');
    } else if (m.includes('invalid_grant') || m.includes('לא תקין')) {
      bad('המפתח הפרטי לא תקין', 'הרץ שוב  npm run link-google');
    } else if (m.includes('SERVICE_DISABLED') || m.includes('has not been used')) {
      bad('Google Sheets API לא מופעל בפרויקט', 'לך ל-Cloud Console → Library → Google Sheets API → Enable');
    } else {
      bad('החיבור נכשל', m.slice(0, 200));
    }
  }
}

// ── 3. הקבוצה ───────────────────────────────────────────────────────
console.log('\n3️⃣  קבוצת הוואטסאפ');
if (!process.env.RECEIPTS_GROUP_ID) {
  bad('לא הוגדרה קבוצה', 'הרץ  npm run groups  כדי לראות את המזהים');
} else if (!process.env.RECEIPTS_GROUP_ID.endsWith('@g.us')) {
  bad('המזהה לא נראה תקין', 'הוא חייב להסתיים ב-@g.us');
} else {
  ok(`מוגדרת: ${process.env.RECEIPTS_GROUP_ID}`);
}

// ── סיכום ───────────────────────────────────────────────────────────
console.log('');
if (failures === 0) {
  console.log('🎉 הכול מחובר. אפשר להריץ:  npm start\n');
} else {
  console.log(`⚠️  ${failures} דברים עוד חסרים. תקן אותם והרץ שוב:  npm run check\n`);
  process.exitCode = 1;
}
