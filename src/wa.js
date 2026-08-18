// =====================================================================
//  wa.js — חיבור לוואטסאפ כמכשיר מקושר על המספר הפרטי.
//
//  הבוט מקשיב אך ורק לקבוצה אחת — זו שמוגדרת ב-RECEIPTS_GROUP_ID.
//  כל שאר הצ'אטים, הקבוצות וההודעות האישיות — לא נקראים, לא נשמרים,
//  ולא נוגעים בהם בכלל. הסינון קורה בשורה הראשונה של המאזין.
// =====================================================================
import fs from 'fs';
import path from 'path';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';

const SESSION_ROOT = process.env.WA_SESSION_PATH || './.wwebjs_auth';

// וואטסאפ ווב מתעדכנת כל כמה ימים, והספרייה נשברת מולה — התסמין הוא
// לולאת "אומת בהצלחה" בלי שאירוע ready נורה אף פעם.
// לכן נועלים גרסה ידועה כתקינה במקום למשוך את החיה.
// אם יום אחד זה נשבר: החלף ל-WA_WEB_VERSION אחרת מהרשימה שב-
// https://github.com/wppconnect-team/wa-version/tree/main/html
const DEBUG = String(process.env.WA_DEBUG ?? 'true') === 'true';

const WEB_VERSION = process.env.WA_WEB_VERSION || '2.3000.1044922618-alpha';
const WEB_CACHE = {
  type: 'remote',
  remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${WEB_VERSION}.html`,
};

// גדלים שמעליהם לא שולחים ל-AI (חוסך זמן וכסף, וגם הגבלת ה-API)
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

// מה הבוט מוכן לקרוא: צילום קבלה, או חשבונית PDF שנשלחה כמסמך
const READABLE_MIME = /^(image\/(jpeg|jpg|png|webp|heic|heif)|application\/pdf)$/i;

/**
 * מרים סשן וואטסאפ.
 * @param {object} opts
 * @param {string} opts.groupId   מזהה הקבוצה להאזנה. ריק = מצב גילוי בלבד.
 * @param {boolean} opts.onlyFromMe  לעבד רק הודעות שאני שלחתי.
 * @param {(session, msg) => Promise<void>} opts.onReceipt
 */
/**
 * מנקה נעילות פרופיל שנשארו מהרצה קודמת.
 *
 * כשקונטיינר נעצר בכוח, Chromium לא מספיק לשחרר את קבצי ה-Singleton
 * בתיקיית הסשן. בהרצה הבאה הוא מסרב לעלות ("The profile appears to be
 * in use by another Chromium process") והבוט נכנס ללולאת אתחול.
 * בטוח למחוק: אנחנו מריצים עותק אחד בלבד.
 */
function clearStaleLocks() {
  const dir = path.resolve(SESSION_ROOT, 'session-receipts');
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('Singleton') || name === 'lockfile') {
        try { fs.rmSync(path.join(dir, name), { force: true, recursive: true }); removed++; } catch { /* לא קריטי */ }
      }
    }
  } catch { /* אין עדיין תיקיית סשן — הרצה ראשונה */ }
  if (removed) console.log(`🧹 נוקו ${removed} נעילות פרופיל שנשארו מהרצה קודמת`);
}

export function createSession({ groupId, onlyFromMe, onReceipt }) {
  clearStaleLocks();

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'receipts', dataPath: SESSION_ROOT }),
    webVersionCache: WEB_CACHE,
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  });

  const session = {
    client,
    state: 'starting',
    phone: null,
    groupId: groupId || null,
    groupName: null,
    reply: (msg, text) => replyTo(session, msg, text),
  };

  // הודעות שהבוט עצמו שלח — כדי שלא יגיב לעצמו
  const sentIds = new Set();
  session._sentIds = sentIds;

  // בשביל מצב הגילוי: לא מציפים את הלוג באותה קבוצה שוב ושוב
  const announced = new Set();

  client.on('qr', async (qr) => {
    session.state = 'qr';
    console.log('\n📲 סרוק את הקוד מהטלפון:');
    console.log('   וואטסאפ → הגדרות → מכשירים מקושרים → קישור מכשיר\n');
    qrTerminal.generate(qr, { small: true });
    try {
      const file = path.resolve('./qr-receipts.png');
      await QRCode.toFile(file, qr, { width: 420, margin: 2 });
      console.log(`   (הקוד נשמר גם כתמונה: ${file})\n`);
    } catch { /* לא קריטי */ }
  });

  client.on('authenticated', () => console.log('🔐 אומת בהצלחה'));

  client.on('ready', async () => {
    session.state = 'ready';
    session.phone = client.info?.wid?.user || null;
    try {
      const f = path.resolve('./qr-receipts.png');
      if (fs.existsSync(f)) fs.unlinkSync(f);   // לא משאירים קוד קישור מסתובב
    } catch { /* לא קריטי */ }

    if (session.groupId) {
      session.groupName = await groupNameOf(client, session.groupId);
      console.log(`✅ מחובר (${session.phone}). מקשיב לקבוצה: ${session.groupName || session.groupId}`);
    } else {
      console.log(`✅ מחובר (${session.phone}).`);
      console.log('⚠️  RECEIPTS_GROUP_ID ריק — מצב גילוי בלבד, שום קבלה לא תעובד.');
      console.log('   הרץ  npm run groups  כדי לראות את רשימת הקבוצות והמזהים שלהן,');
      console.log('   או פשוט שלח הודעה בקבוצה והמזהה יודפס כאן.\n');
    }
  });

  client.on('auth_failure', (m) => {
    session.state = 'disconnected';
    console.error('❌ כשל אימות —', m);
  });

  client.on('disconnected', (reason) => {
    session.state = 'disconnected';
    console.error(`⚠️  נותק (${reason}). מנסה להתחבר מחדש בעוד 5 שניות...`);
    setTimeout(() => client.initialize().catch((e) => console.error(e.message)), 5000);
  });

  client.on('message_create', async (msg) => {
    try {
      const chatId = chatIdOf(msg);
      if (!chatId.endsWith('@g.us')) return;         // לא קבוצה — לא מעניין אותנו

      // שורת אבחון: מראה בדיוק מה הבוט רואה, אחרי סינון הקבוצות בלבד.
      // כבה עם WA_DEBUG=false ברגע שהכול עובד.
      // מכוון: צ'אטים פרטיים לא מגיעים לכאן ולא נרשמים ללוג.
      if (DEBUG) {
        const mine = chatId === session.groupId ? '★' : ' ';
        console.log(`📨${mine} chat=${chatId} fromMe=${msg.fromMe} type=${msg.type} media=${msg.hasMedia}`);
      }

      // מצב גילוי: אין קבוצה מוגדרת — רק מדפיסים מי זו, ולא נוגעים בתוכן.
      //
      // מדווחים רק על הודעות שאני עצמי שלחתי. בלי הסינון הזה, הודעה
      // אקראית מקבוצה אחרת שהגיעה באותו רגע הייתה מזוהה בטעות
      // כקבוצת הקבלות — וזה בדיוק מה שקרה בבנייה.
      if (!session.groupId) {
        if (!msg.fromMe) return;
        if (!announced.has(chatId)) {
          announced.add(chatId);
          const name = await groupNameOf(client, chatId);
          console.log(`\n🔎 קבוצה שכתבת בה: "${name || '(שם לא זמין)'}"`);
          console.log(`   RECEIPTS_GROUP_ID=${chatId}`);
          console.log('   ⚠️  ודא שהשם למעלה הוא באמת קבוצת הקבלות שלך!\n');
        }
        return;
      }

      if (chatId !== session.groupId) return;         // קבוצה אחרת — מתעלמים לגמרי
      if (onlyFromMe && !msg.fromMe) return;          // תמונות של אחרים — לא נוגעים
      if (sentIds.has(msgIdOf(msg))) return;          // הודעה שהבוט עצמו שלח
      if (!msg.hasMedia) return;                      // טקסט בקבוצה — לא מעניין

      await onReceipt(session, msg);
    } catch (e) {
      console.error('שגיאה בטיפול בהודעה:', e.message || e);
    }
  });

  return session;
}

// ── תגובה בתוך הקבוצה, כשרשור על ההודעה המקורית ─────────────────────
export async function replyTo(session, msg, text) {
  if (!text) return null;
  if (session.state !== 'ready') {
    console.warn('⚠️  לא מחובר — התגובה לא נשלחה.');
    return null;
  }
  try {
    const sent = await msg.reply(text);
    const id = msgIdOf(sent);
    if (id) {
      session._sentIds.add(id);
      if (session._sentIds.size > 500) session._sentIds.clear();
    }
    return sent;
  } catch (e) {
    console.error('שליחת תגובה נכשלה:', e.message || e);
    return null;
  }
}

/**
 * מעדכן הודעה שהבוט כבר שלח, במקום לשלוח חדשה.
 * אם העריכה נכשלת (וואטסאפ מגבילה לחלון זמן, והספרייה לא תמיד עומדת
 * בזה) — שולחים הודעה חדשה, כדי שהמשתמש תמיד יקבל תשובה.
 */
export async function updateOrReply(session, ack, original, text) {
  if (ack) {
    try {
      await ack.edit(text);
      return ack;
    } catch (e) {
      if (DEBUG) console.log(`   ↩︎ עריכת ההודעה נכשלה (${e.message}), שולח חדשה`);
    }
  }
  return replyTo(session, original, text);
}

// ── הורדת הקובץ מההודעה ─────────────────────────────────────────────
/**
 * מחזיר { base64, mimetype, bytes, filename } או null אם זה לא משהו שאפשר לקרוא.
 * @param {import('whatsapp-web.js').Message} msg
 */
export async function downloadReceipt(msg) {
  if (!msg.hasMedia) return null;

  // 'image' = צילום/תמונה, 'document' = קובץ (בדרך כלל PDF של חשבונית)
  if (msg.type !== 'image' && msg.type !== 'document') return null;

  let media = null;
  try {
    media = await msg.downloadMedia();
  } catch (e) {
    // הדרך של הספרייה נשברה — עוברים למסלול העצמאי
    if (DEBUG) console.log(`   ↩︎ downloadMedia של הספרייה נכשל (${e.message}), עובר לדרך העוקפת`);
  }
  if (!media?.data) media = await downloadViaInternals(msg);
  if (!media?.data) return null;

  const mimetype = String(media.mimetype || '').split(';')[0].trim().toLowerCase();
  if (!READABLE_MIME.test(mimetype)) return null;

  const bytes = Math.floor((media.data.length * 3) / 4);
  if (bytes > MAX_MEDIA_BYTES) {
    const err = new Error('too-large');
    err.bytes = bytes;
    throw err;
  }

  return { base64: media.data, mimetype, bytes, filename: media.filename || null };
}

// ── מזהה ההודעה ─────────────────────────────────────────────────────
//
//  _serialized אמור להכיל את המזהה המלא, אבל בהודעות חיות הוא מגיע
//  ריק לפעמים. במקרה כזה מרכיבים אותו מהחלקים, בדיוק בפורמט שוואטסאפ
//  משתמשת בו:  fromMe_chat_hash_participant
//  לדוגמה: true_1203634...@g.us_AC3C9AD642...F_179598419583094@lid
export function msgIdOf(msg) {
  const direct = msg?.id?._serialized;
  if (direct) return direct;

  const id = msg?.id;
  if (!id) return '';

  const ser = (x) => {
    if (!x) return '';
    if (typeof x === 'string') return x;
    if (x._serialized) return x._serialized;
    const s = String(x);
    return s.startsWith('[object') ? '' : s;
  };

  const parts = [
    id.fromMe === undefined ? 'false' : String(!!id.fromMe),
    ser(id.remote),
    ser(id.id) || String(id.id || ''),
  ];
  if (!parts[1] || !parts[2]) return '';

  const participant = ser(id.participant);
  if (participant) parts.push(participant);
  return parts.join('_');
}

// ── הורדת מדיה בדרך עוקפת ───────────────────────────────────────────
//
//  הרקע: whatsapp-web.js 1.34.7 קוראת ל-window.require('WAWebCollections').Msg
//  כדי למצוא את ההודעה, והמודול הזה כבר לא מחזיק את אוסף ההודעות —
//  התוצאה היא שגיאה סתומה בשם "r". גם getChats ו-getChatById נופלות שם.
//
//  ההורדה עצמה (WAWebDownloadManager) דווקא תקינה לגמרי. לכן אנחנו
//  מוצאים את ההודעה דרך WAWebMsgCollection ומפעילים את אותה הורדה
//  בדיוק — כולל הפענוח — ומחזירים base64.
export async function downloadViaInternals(msg) {
  const page = msg.client?.pupPage;
  const id = msgIdOf(msg);
  if (!page || !id) {
    if (DEBUG) console.log(`   ↩︎ אי אפשר להתחיל: page=${!!page} id=${id || '(ריק)'}`);
    return null;
  }

  // גם בצד Node — כדי ששום תקיעה בדפדפן לא תשתק את הבוט
  const res = await Promise.race([
    page.evaluate(async (msgId) => {
    // ── איתור ההודעה, לפי כמה שמות מודול אפשריים ──
    const fromCollection = (mod, key) => {
      try {
        const m = window.require(mod);
        const col = m?.[key] || m?.default;
        return col?.get?.(msgId) || null;
      } catch { return null; }
    };

    let m = fromCollection('WAWebMsgCollection', 'MsgCollection')
      || fromCollection('WAWebCollections', 'Msg');

    if (!m) {
      try {
        const col = window.require('WAWebMsgCollection')?.MsgCollection;
        const r = await col?.getMessagesById?.([msgId]);
        m = r?.messages?.[0] || null;
      } catch { /* ננסה סריקה */ }
    }

    // רשת ביטחון: אם המזהה שהרכבנו לא תואם בדיוק, מחפשים לפי החלק
    // הייחודי שלו (ה-hash) בתוך אוסף ההודעות.
    if (!m) {
      try {
        const hash = String(msgId).split('_')[2] || '';
        const col = window.require('WAWebMsgCollection')?.MsgCollection;
        const arr = col?.getModelsArray?.() || [];
        m = arr.find((x) => x?.id?.id === hash) || null;
      } catch { /* ויתרנו */ }
    }

    if (!m) return { error: `ההודעה לא נמצאה במאגר (${msgId})` };
    if (!m.mediaData) return { error: 'להודעה אין מדיה' };
    if (m.mediaData.mediaStage === 'REUPLOADING') return { error: 'המדיה פגה בוואטסאפ' };

    // אבחון — חוזר גם בכישלון, כדי שנדע מה חסר
    const diag = {
      stage: String(m.mediaData.mediaStage || ''),
      hasDirectPath: !!m.directPath,
      hasMediaKey: !!m.mediaKey,
      hasFilehash: !!m.filehash,
      type: m.type,
      mimetype: m.mimetype,
    };

    // כל שלב מוגבל בזמן — בלי זה תקיעה בדפדפן משתקת את הבוט לנצח
    const limit = (p, ms, label) => Promise.race([
      Promise.resolve(p),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`נתקע: ${label}`)), ms)),
    ]);

    // אם המדיה עוד לא נפתרה — מבקשים מוואטסאפ למשוך אותה.
    // לא חוסמים על זה: אם יש לנו directPath+mediaKey אפשר להוריד גם בלי.
    if (diag.stage !== 'RESOLVED') {
      try {
        await limit(m.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 }), 20000, 'resolve');
        diag.stage = String(m.mediaData.mediaStage || '');
      } catch (e) {
        diag.resolveError = String(e?.message || e);
      }
    }
    if (!m.directPath || !m.mediaKey) {
      return { error: `אין מפתחות להורדה (שלב ${diag.stage})`, diag };
    }

    // ── ההורדה והפענוח ──
    const mockQpl = { addAnnotations() { return this; }, addPoint() { return this; } };
    let raw;
    try {
      raw = await limit(
        window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
          directPath: m.directPath,
          encFilehash: m.encFilehash,
          filehash: m.filehash,
          mediaKey: m.mediaKey,
          mediaKeyTimestamp: m.mediaKeyTimestamp,
          type: m.type,
          signal: new AbortController().signal,
          downloadQpl: mockQpl,
        }),
        60000,
        'download',
      );
    } catch (e) {
      return { error: `הורדה נכשלה: ${e?.message || e}`, diag };
    }

    // ── חילוץ הבתים ──
    // downloadAndMaybeDecrypt לא מחזיר תמיד ArrayBuffer; לפעמים זה Blob
    // ולפעמים עטיפה פנימית. מפרקים לפי צורה, ולא לפי הנחה.
    const toBytes = async (x, depth = 0) => {
      if (!x || depth > 3) return null;
      if (x instanceof ArrayBuffer) return new Uint8Array(x);
      if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
      if (typeof x.arrayBuffer === 'function') {
        try { return new Uint8Array(await x.arrayBuffer()); } catch { /* ננסה אחרת */ }
      }
      if (typeof x.forceToBlob === 'function') {
        try { return await toBytes(await x.forceToBlob(), depth + 1); } catch { /* ננסה אחרת */ }
      }
      for (const k of ['_blob', 'blob', 'mediaBlob', 'data', 'buffer', 'file', 'result']) {
        if (x[k]) {
          const r = await toBytes(x[k], depth + 1);
          if (r?.length) return r;
        }
      }
      return null;
    };

    const bytes = await toBytes(raw);
    if (!bytes?.length) {
      diag.rawCtor = raw?.constructor?.name || typeof raw;
      diag.rawKeys = raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 12) : null;
      diag.rawSize = raw?.size ?? raw?.byteLength ?? null;
      return { error: 'ההורדה החזירה מבנה שלא הצלחתי לפרק', diag };
    }

    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
      return {
        data: btoa(bin),
        mimetype: m.mimetype || 'image/jpeg',
        filename: m.filename || null,
      };
    }, id),
    new Promise((resolve) => setTimeout(() => resolve({ error: 'פסק זמן כללי (90 שניות)' }), 90000)),
  ]);

  if (!res || res.error) {
    if (DEBUG) {
      console.log(`   ↩︎ הדרך העוקפת נכשלה: ${res?.error || 'החזירה ריק'}`);
      if (res?.diag) console.log(`      אבחון: ${JSON.stringify(res.diag)}`);
    }
    return null;
  }
  return res;
}

// מזהה הצ'אט שאליו ההודעה שייכת.
//
// שלושה שדות עשויים להכיל אותו, ואף אחד מהם לא אמין לבדו:
//  · בהודעה שאני שולח, from הוא אני ו-to הוא היעד — הפוך מהודעה נכנסת.
//  · וואטסאפ עברה למיעון @lid, ולפעמים id.remote מחזיר כתובת כזו
//    במקום את ה-@g.us של הקבוצה.
// לכן: אם אחד מהמועמדים הוא קבוצה — הוא הנכון. אחרת לוקחים את הראשון.
function chatIdOf(msg) {
  const candidates = [msg.id?.remote, msg.to, msg.from].filter(Boolean).map(String);
  return candidates.find((c) => c.endsWith('@g.us')) || candidates[0] || '';
}

// ── שם הקבוצה, בלי להתפוצץ אם משהו לא זמין ──────────────────────────
export async function groupNameOf(client, id) {
  try {
    const chat = await client.getChatById(id);
    return chat?.name || null;
  } catch {
    return null;
  }
}
