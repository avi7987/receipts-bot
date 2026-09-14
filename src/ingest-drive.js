// =====================================================================
//  ingest-drive.js — קולט קבלות מתיקיית דרייב אל גיליון.
//
//  הרצה:
//    DRIVE_FOLDER_ID=... GOOGLE_SHEET_ID=... npm run drive
//
//  בטוח להרצה חוזרת: לפני כתיבה בודקים מול הגיליון אם הקבלה כבר שם.
//  הגיליון הוא מקור האמת — לא זיכרון מקומי — כך שאם מחקת שורה,
//  הרצה נוספת תחזיר אותה, וזה בדיוק מה שמצופה.
//
//  שדות שאי אפשר לקרוא מהתמונה (לקוח, שמות סועדים, רכב חלופי)
//  נשארים ריקים במכוון. בלי צ'אט אין את מי לשאול, והם מולאים ידנית
//  בגיליון לפני הרצת הסימנייה.
// =====================================================================
import 'dotenv/config';
import { folderInfo, listReceipts, download, driveConfigured } from './drive.js';
import { readReceipt, visionAvailable } from './vision.js';
import { appendRow, rowFrom, findRow, sheetUrl, sheetsConfigured } from './sheets.js';
import { saveForServing } from './storage.js';

const FOLDER = (process.env.DRIVE_FOLDER_ID || '').trim();

if (!FOLDER) { console.error('❌ חסר DRIVE_FOLDER_ID'); process.exit(1); }
if (!driveConfigured()) { console.error('❌ חסרים פרטי חשבון השירות'); process.exit(1); }
if (!visionAvailable()) { console.error('❌ חסר GEMINI_API_KEY'); process.exit(1); }
if (!sheetsConfigured()) { console.error('❌ חסרות הגדרות הגיליון'); process.exit(1); }

// ── התיקייה ─────────────────────────────────────────────────────────
let info;
try {
  info = await folderInfo(FOLDER);
} catch (e) {
  const why = {
    'folder-not-shared': 'התיקייה לא משותפת עם חשבון השירות (או שהמזהה שגוי)',
    'not-a-folder': 'המזהה הזה אינו תיקייה',
    'folder-not-readable': 'התיקייה משותפת אבל בלי הרשאת קריאה',
  }[e.message] || e.message;
  console.error(`❌ ${why}`);
  process.exit(1);
}
console.log(`📁 ${info.name}`);

const files = await listReceipts(FOLDER);
console.log(`   ${files.length} קבצים לבדיקה\n`);

let added = 0, skipped = 0, failedCount = 0;

for (const file of files) {
  const label = file.name.length > 45 ? `${file.name.slice(0, 42)}…` : file.name;
  process.stdout.write(`· ${label} `);

  let media;
  try {
    media = await download(file);
  } catch (e) {
    console.log(`❌ הורדה: ${e.message}`);
    failedCount++;
    continue;
  }

  let data;
  try {
    data = await readReceipt(media.base64, media.mimetype, null);
  } catch (e) {
    console.log(`❌ קריאה: ${String(e.message).slice(0, 80)}`);
    failedCount++;
    continue;
  }

  if (!data.is_receipt) {
    console.log(`⤫ לא קבלה (${data.not_receipt_reason || 'לא זוהתה'})`);
    skipped++;
    continue;
  }

  const existing = await findRow({
    doc_number: data.doc_number, date: data.date, total: data.total_with_tip,
  }).catch(() => null);

  if (existing) {
    console.log(`♻️  כבר בשורה ${existing}`);
    skipped++;
    continue;
  }

  const served = saveForServing(media.base64, media.mimetype, file.name);
  const row = await appendRow(rowFrom(data, served?.url || null));
  added++;
  console.log(`✅ שורה ${row} — ${data.vendor || '?'} · ${data.total_with_tip} ${data.currency}`);
}

console.log(`\nנוספו ${added} · דולגו ${skipped} · נכשלו ${failedCount}`);
console.log(sheetUrl());
