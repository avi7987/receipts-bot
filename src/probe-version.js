// =====================================================================
//  probe-version.js — מוצא איזו גרסת וואטסאפ ווב עובדת עם הספרייה.
//
//  הרצה:  npm run probe
//
//  הרקע: whatsapp-web.js קוראת לפונקציות פנימיות של וואטסאפ ווב.
//  כשהגרסה החיה מקדימה את הספרייה, כל הקריאות האלה מתרסקות עם
//  שגיאה סתומה בשם "r" — getChats, getChatById, downloadMedia.
//  הסקריפט הזה מנסה כמה גרסאות ומדווח איזו באמת עובדת, כולל
//  ניסיון הורדה אמיתי של תמונה מקבוצת הקבלות.
// =====================================================================
import 'dotenv/config';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

const GROUP = process.env.RECEIPTS_GROUP_ID || '';
const SESSION = process.env.WA_SESSION_PATH || './.wwebjs_auth';

// מועמדות, מהחדשה לישנה. 1.34.7 שוחררה ב-24.4.2026, אז הסבירות
// הגבוהה ביותר היא באמצע-סוף הטווח.
const CANDIDATES = process.argv.slice(2).length ? process.argv.slice(2) : [
  '2.3000.1044261014-alpha',
  '2.3000.1043984129-alpha',
  '2.3000.1043705293-alpha',
  '2.3000.1043421788-alpha',
  '2.3000.1043159177-alpha',
  '2.3000.1042861661-alpha',
];

function makeClient(version) {
  return new Client({
    authStrategy: new LocalAuth({ clientId: 'receipts', dataPath: SESSION }),
    webVersionCache: {
      type: 'remote',
      remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${version}.html`,
    },
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  });
}

/** מריץ בדיקה אחת ומחזיר { ready, chats, media } */
async function probe(version) {
  const client = makeClient(version);
  const result = { ready: false, chats: false, media: null };

  const ready = new Promise((resolve) => {
    client.on('ready', () => resolve(true));
    client.on('auth_failure', () => resolve(false));
    setTimeout(() => resolve(false), 120000);       // תקוע = נכשל
  });

  try {
    client.initialize().catch(() => {});
    result.ready = await ready;
    if (!result.ready) return result;

    // בדיקה 1: הקריאה הפנימית הבסיסית
    try {
      const chats = await client.getChats();
      result.chats = Array.isArray(chats) && chats.length > 0;
    } catch { /* נשאר false */ }

    // בדיקה 2: מה שבאמת מעניין אותנו — הורדת תמונה אמיתית
    if (result.chats && GROUP) {
      try {
        const chat = await client.getChatById(GROUP);
        const msgs = await chat.fetchMessages({ limit: 10 });
        const withMedia = msgs.reverse().find((m) => m.hasMedia && m.type === 'image');
        if (!withMedia) {
          result.media = 'אין תמונה בקבוצה לבדיקה';
        } else {
          const m = await withMedia.downloadMedia();
          result.media = m?.data ? `הורדה הצליחה (${Math.round(m.data.length * 0.75 / 1024)}KB)` : 'הורדה החזירה ריק';
        }
      } catch (e) {
        result.media = `הורדה נכשלה: ${e.message}`;
      }
    }
  } finally {
    await client.destroy().catch(() => {});
  }
  return result;
}

// ── ריצה ────────────────────────────────────────────────────────────
console.log(`🔬 בודק ${CANDIDATES.length} גרסאות. כל אחת לוקחת ~40 שניות.\n`);

let winner = null;
for (const v of CANDIDATES) {
  process.stdout.write(`   ${v} ... `);
  let r;
  try {
    r = await probe(v);
  } catch (e) {
    console.log(`❌ ${e.message}`);
    continue;
  }

  if (!r.ready) { console.log('❌ לא התחבר'); continue; }
  if (!r.chats) { console.log('⚠️  התחבר, אבל getChats נכשל'); continue; }

  const mediaOk = typeof r.media === 'string' && r.media.startsWith('הורדה הצליחה');
  console.log(mediaOk ? `✅ עובד — ${r.media}` : `⚠️  getChats עובד · ${r.media || 'לא נבדקה הורדה'}`);

  if (mediaOk) { winner = v; break; }
  if (!winner) winner = v;   // מועמד סביר, ממשיכים לחפש טוב יותר
}

console.log('');
if (winner) {
  console.log(`🎉 הגרסה המומלצת:  ${winner}`);
  console.log(`   שים אותה ב-.env:  WA_WEB_VERSION=${winner}\n`);
} else {
  console.log('😕 אף אחת מהמועמדות לא עבדה.');
  console.log('   נסה טווח אחר:  npm run probe -- 2.3000.1042251103-alpha 2.3000.1041951580-alpha\n');
  process.exitCode = 1;
}
