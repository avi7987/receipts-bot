// =====================================================================
//  test-last.js — לוקח את התמונה האחרונה שנשלחה לקבוצת הקבלות
//  ומריץ עליה את כל המסלול: הורדה → קריאה ב-AI → שורה בגיליון.
//
//  הרצה:  npm run test-last
//         npm run test-last -- --dry     (בלי לכתוב לגיליון)
//
//  שימושי כדי לבדוק את השרשרת בלי לשלוח קבלה חדשה בכל פעם.
// =====================================================================
import 'dotenv/config';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { downloadViaInternals } from './wa.js';
import { readReceipt } from './vision.js';
import { appendRow, rowFrom, sheetUrl } from './sheets.js';
import { receiptMessage } from './format.js';

const GROUP = process.env.RECEIPTS_GROUP_ID || '';
const DRY = process.argv.includes('--dry');

if (!GROUP) {
  console.error('❌ חסר RECEIPTS_GROUP_ID ב-.env');
  process.exit(1);
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'receipts', dataPath: process.env.WA_SESSION_PATH || './.wwebjs_auth' }),
  webVersionCache: {
    type: 'remote',
    remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${process.env.WA_WEB_VERSION || '2.3000.1044922618-alpha'}.html`,
  },
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  },
});

client.on('ready', async () => {
  console.log('✅ מחובר. מחפש את התמונה האחרונה בקבוצה...\n');

  // מאתרים את ההודעה דרך המאגר הפנימי — getChats/fetchMessages שבורות
  const found = await client.pupPage.evaluate((groupId) => {
    let all = [];
    try {
      const col = window.require('WAWebMsgCollection')?.MsgCollection;
      all = col?.getModelsArray?.() || [];
    } catch { return { error: 'לא הצלחתי לגשת לאוסף ההודעות' }; }

    // מזהה ההודעה עשוי להיות מחרוזת, אובייקט Wid, או אובייקט עם toString
    const serial = (x) => {
      if (!x) return '';
      if (typeof x === 'string') return x;
      if (x._serialized) return x._serialized;
      try { const s = String(x); return s.startsWith('[object') ? '' : s; } catch { return ''; }
    };
    const hits = all
      .filter((m) => serial(m?.id?.remote) === groupId)
      .filter((m) => m?.type === 'image' || m?.type === 'document')
      .sort((a, b) => (b.t || 0) - (a.t || 0));

    if (!hits.length) return { error: 'לא נמצאה תמונה בקבוצה', scanned: all.length };
    const m = hits[0];
    return {
      id: serial(m.id),
      type: m.type,
      when: m.t ? new Date(m.t * 1000).toISOString() : null,
      // body של תמונה מכיל לפעמים תמונה ממוזערת ב-base64, לא כיתוב
      caption: (() => {
        const s = String(m.caption || m.body || '').trim();
        if (!s || s.length > 400) return null;
        if (/^\/9j\/|^iVBORw0|^data:image\//i.test(s)) return null;
        if (/^[A-Za-z0-9+/=\s]{120,}$/.test(s)) return null;
        return s;
      })(),
      total: hits.length,
    };
  }, GROUP);

  if (found?.error) {
    console.error(`❌ ${found.error}${found.scanned ? ` (נסרקו ${found.scanned} הודעות)` : ''}`);
    console.error('   שלח תמונת קבלה לקבוצה ונסה שוב.');
    await client.destroy();
    process.exit(1);
  }

  console.log(`📎 נמצאה: ${found.type} מתאריך ${found.when?.slice(0, 16).replace('T', ' ') || '?'}`);
  console.log(`   מזהה: ${found.id || '❌ ריק — זו הבעיה'}`);
  if (found.caption) console.log(`   כיתוב: "${found.caption}"`);
  console.log(`   (סה"כ ${found.total} תמונות בקבוצה)\n`);

  // ── הורדה ──
  console.log('⬇️  מוריד...');
  const fake = { client, id: { _serialized: found.id } };
  const media = await downloadViaInternals(fake);
  if (!media?.data) {
    console.error('❌ ההורדה נכשלה. זו החוליה שעדיין שבורה.');
    await client.destroy();
    process.exit(1);
  }
  const kb = Math.round((media.data.length * 0.75) / 1024);
  console.log(`   ✅ ${kb}KB · ${media.mimetype}\n`);

  // ── קריאה ──
  console.log('🤖 קורא את הקבלה...');
  const t0 = Date.now();
  const r = await readReceipt(media.data, media.mimetype.split(';')[0], found.caption);
  console.log(`   ✅ ${((Date.now() - t0) / 1000).toFixed(1)} שניות\n`);

  if (!r.is_receipt) {
    console.log(`🤷 לא זוהתה כקבלה: ${r.not_receipt_reason || '—'}`);
    await client.destroy();
    process.exit(0);
  }

  console.log('── מה חולץ ──');
  console.log(`   ספק:            ${r.vendor || '—'}`);
  console.log(`   תאריך:          ${r.date || '—'}`);
  console.log(`   סכום:           ${r.total ?? '—'}`);
  console.log(`   טיפ נוסף:       ${r.tip_extra ?? '—'}`);
  console.log(`   סכום כולל:      ${r.total_with_tip ?? '—'}`);
  console.log(`   מספר חשבונית:   ${r.doc_number || '—'}`);
  console.log(`   לבדיקה:         ${r.uncertain.length ? r.uncertain.join(', ') : 'אין'}\n`);

  // ── גיליון ──
  let row = null;
  if (DRY) {
    console.log('🧪 מצב יבש — לא נכתב לגיליון.\n');
  } else {
    row = await appendRow(rowFrom(r));
    console.log(`📊 נכתב לשורה ${row}\n`);
  }

  console.log('── ההודעה שהייתה חוזרת לקבוצה ──');
  console.log(receiptMessage(r, { row, sheetUrl: row ? sheetUrl(row) : null }));

  await client.destroy();
  process.exit(0);
});

client.on('auth_failure', (m) => { console.error('❌ כשל אימות —', m); process.exit(1); });

console.log('⏳ מתחבר...');
client.initialize().catch((e) => { console.error('❌', e.message); process.exit(1); });
