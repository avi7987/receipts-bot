// =====================================================================
//  list-groups.js — עזר חד-פעמי: מדפיס את כל הקבוצות שאתה חבר בהן
//  ואת המזהה של כל אחת, כדי שתדע מה לשים ב-RECEIPTS_GROUP_ID.
//
//  הרצה:  npm run groups
//  לא קורא הודעות ולא כותב כלום — רק שמות ומזהים.
// =====================================================================
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';

const WEB_VERSION = process.env.WA_WEB_VERSION || '2.3000.1044922618-alpha';

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'receipts', dataPath: process.env.WA_SESSION_PATH || './.wwebjs_auth' }),
  webVersionCache: {
    type: 'remote',
    remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${WEB_VERSION}.html`,
  },
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  },
});

// הקוד מוצג גם בטרמינל וגם נשמר כתמונה — כי בחלק מהמסופים
// הקוד לא מוצג כמו שצריך, ואז סורקים מהתמונה.
const QR_FILE = path.resolve('./qr-receipts.png');
let qrCount = 0;

client.on('qr', async (qr) => {
  qrCount++;
  console.log(`\n📲 סרוק את הקוד מהטלפון (וואטסאפ → מכשירים מקושרים) — קוד #${qrCount}:\n`);
  qrTerminal.generate(qr, { small: true });
  try {
    await QRCode.toFile(QR_FILE, qr, { width: 460, margin: 3 });
    console.log(`\n   🖼️  הקוד נשמר גם כתמונה: ${QR_FILE}`);
    console.log('   הקוד מתחדש כל ~30 שניות. אם פג — פשוט סרוק את החדש.\n');
  } catch (e) {
    console.error('   שמירת התמונה נכשלה:', e.message);
  }
});

function cleanupQr() {
  try { if (fs.existsSync(QR_FILE)) fs.unlinkSync(QR_FILE); } catch { /* לא קריטי */ }
}

client.on('authenticated', () => {
  cleanupQr();                       // לא משאירים קוד קישור מסתובב
  console.log('\n🔐 החיבור אושר! טוען את רשימת הקבוצות...\n');
});

// getChats() מתרסק ("r: r") בחלק מהשילובים של whatsapp-web.js מול
// וואטסאפ ווב. במקרה כזה קוראים ישירות מהמאגר הפנימי של הדפדפן.
async function readGroups() {
  try {
    const chats = await client.getChats();
    return chats.filter((c) => c.isGroup).map((c) => ({ id: c.id._serialized, name: c.name || '' }));
  } catch (e) {
    console.log('ℹ️  הדרך הרגילה נכשלה, מנסה דרך עוקפת...');
  }
  return client.pupPage.evaluate(() => {
    for (const mod of ['WAWebChatCollection', 'WAWebChatStore']) {
      try {
        const col = window.require(mod);
        const store = col.ChatCollection || col.ChatStore || col.default;
        const list = store?.getModelsArray?.() || [];
        if (list.length) {
          return list
            .filter((c) => c?.id?.server === 'g.us')
            .map((c) => ({ id: c.id._serialized, name: c.formattedTitle || c.name || '' }));
        }
      } catch { /* מנסים את המודול הבא */ }
    }
    return null;
  });
}

client.on('ready', async () => {
  cleanupQr();
  const groups = await readGroups();

  if (!groups) {
    console.log('\n❌ לא הצלחתי לשלוף את רשימת הקבוצות מהגרסה הזו של וואטסאפ ווב.');
    console.log('   אין בעיה — יש דרך פשוטה יותר. הרץ:  npm start');
    console.log('   ואז שלח הודעה כלשהי בקבוצת הקבלות. המזהה יודפס שם.\n');
    await client.destroy();
    process.exit(2);
  }

  if (!groups.length) {
    console.log('\nלא נמצאו קבוצות בחשבון הזה.\n');
  } else {
    console.log(`\n📋 נמצאו ${groups.length} קבוצות:\n`);
    for (const g of groups) {
      console.log(`   ${g.name || '(ללא שם)'}`);
      console.log(`   RECEIPTS_GROUP_ID=${g.id}\n`);
    }
    console.log('העתק את השורה של קבוצת הקבלות לתוך קובץ ה-.env, ואז הרץ  npm start\n');
  }

  await client.destroy();
  process.exit(0);
});

client.on('auth_failure', (m) => {
  console.error('❌ כשל אימות —', m);
  process.exit(1);
});

console.log('⏳ מתחבר לוואטסאפ...');
client.initialize().catch((e) => {
  console.error('❌ האתחול נכשל —', e.message || e);
  process.exit(1);
});
