// =====================================================================
//  index.js — נקודת הכניסה של בוט הקבלות.
//
//  המסלול של כל קבלה:
//    תמונה בקבוצה → הורדה → בדיקת כפילות → קריאה ב-AI →
//    שמירת התמונה → שורה ב-Google Sheets → תגובה בקבוצה.
//
//  אם שלב נכשל, הבוט אומר את זה בקבוצה בעברית פשוטה. הוא אף פעם
//  לא שותק ואף פעם לא ממציא נתון שלא הופיע בקבלה.
// =====================================================================
import 'dotenv/config';
import http from 'http';
import {
  createSession, downloadReceipt, downloadReceiptById,
  msgIdOf, updateOrReply, scanGroupMedia, sendToGroup,
} from './wa.js';
import { readReceipt, visionAvailable } from './vision.js';
import { appendRow, rowFrom, sheetUrl, sheetsConfigured } from './sheets.js';
import { saveReceipt, storageMode } from './storage.js';
import * as state from './state.js';
import { receiptMessage, notReceiptMessage, errorMessage, heDate, money } from './format.js';

const STARTED_AT = Date.now();
const PORT = process.env.PORT || 3100;
const GROUP_ID = (process.env.RECEIPTS_GROUP_ID || '').trim();
const ONLY_FROM_ME = String(process.env.ONLY_FROM_ME ?? 'true') === 'true';
// כמה אחורה מותר לקלוט קבלות שנשלחו בזמן שהבוט היה כבוי
const CATCHUP_HOURS = Number(process.env.CATCHUP_HOURS || 24);

let processed = 0;
let failed = 0;

// ── טיפול בקבלה שהגיעה כאירוע ───────────────────────────────────────
async function onReceipt(session, msg) {
  const msgId = msgIdOf(msg) || null;

  // הודעות ישנות מדי (סנכרון היסטוריה של וואטסאפ) — לא נוגעים
  const ageHours = msg.timestamp ? (Date.now() - msg.timestamp * 1000) / 3600e3 : 0;
  if (ageHours > CATCHUP_HOURS) return;

  return handleReceipt(session, {
    msgId,
    caption: cleanCaption(msg.body),
    kind: msg.type,
    replyTo: msg,
    download: () => downloadReceipt(msg),
  });
}

// ── הליבה: אותו טיפול, בין אם ההודעה הגיעה כאירוע ובין אם בסריקה ────
async function handleReceipt(session, job) {
  const { msgId, caption, kind, replyTo } = job;
  const say = (text) => (replyTo ? session.reply(replyTo, text) : sendToGroup(session, text));

  if (state.seenMessage(msgId)) return;

  // ── הורדה ──
  let media;
  try {
    media = await job.download();
  } catch (e) {
    if (e.message === 'too-large') {
      state.rememberMessage(msgId);
      await say(errorMessage('too-large'));
      return;
    }
    throw e;
  }
  if (!media) {
    // סטיקר, וידאו, קובץ וורד וכו' — פשוט לא בשבילנו
    state.rememberMessage(msgId);
    if (kind === 'document') await say(errorMessage('unsupported'));
    return;
  }

  // ── כפילות: אותה תמונה בדיוק ──
  const hash = state.hashOf(media.base64);
  const before = state.seenImage(hash);
  if (before) {
    state.rememberMessage(msgId);
    await say(errorMessage('duplicate', before.label || null));
    return;
  }

  await react(replyTo, '⏳');

  // אישור מיידי — כדי שתדע שהקבלה נתפסה ולא נעלמה.
  // ההודעה הזו תתעדכן בהמשך לתוצאה הסופית, כך שלא נשארות שתי הודעות.
  const ack = await say('⏳ *קיבלתי קבלה* — קורא אותה...');

  // ── קריאה ב-AI ──
  let data;
  try {
    data = await readReceipt(media.base64, media.mimetype, caption);
  } catch (e) {
    failed++;
    await react(replyTo, '❌');
    state.rememberMessage(msgId);
    const why = e.message === 'missing-gemini-key' ? 'missing-gemini-key' : 'read-failed';
    console.error('קריאת הקבלה נכשלה:', e.message || e);
    await updateOrReply(session, ack, replyTo, errorMessage(why, why === 'read-failed' ? short(e.message) : null));
    return;
  }

  if (!data.is_receipt) {
    await react(replyTo, '🤷');
    state.rememberMessage(msgId);
    await updateOrReply(session, ack, replyTo, notReceiptMessage(data.not_receipt_reason));
    return;
  }

  // ── שמירת התמונה (לא קריטי — לא מפיל את התהליך) ──
  const link = await saveReceipt(media.base64, media.mimetype, {
    date: data.date, vendor: data.vendor, total: data.total, id: msgId,
  });

  // ── שורה בגיליון ──
  let row = null;
  try {
    row = await appendRow(rowFrom(data));
  } catch (e) {
    failed++;
    await react(replyTo, '❌');
    console.error('כתיבה לגיליון נכשלה:', e.message || e);
    const why = e.message === 'sheets-not-configured' ? 'sheets-not-configured' : 'sheet-failed';
    await updateOrReply(session, ack, replyTo, errorMessage(why, why === 'sheet-failed' ? short(e.message) : null));
    return;   // לא רושמים בזיכרון — כך שליחה חוזרת אחרי תיקון תעבוד
  }

  // ── סיום ──
  processed++;
  state.remember(msgId, hash, { label: labelOf(data), row });
  await react(replyTo, '✅');
  await updateOrReply(session, ack, replyTo, receiptMessage(data, { row, sheetUrl: sheetUrl(row) }));

  console.log(`🧾 ${data.vendor || '?'} · ${data.date || '?'} · ${data.total_with_tip ?? '?'} ${data.currency} → שורה ${row ?? '?'}`);
}

// הכיתוב של תמונה מכיל לפעמים תמונה ממוזערת בקידוד base64 במקום טקסט.
// זה לא כיתוב — ואסור לשלוח את זה ל-AI כאילו זו הערה של המשתמש.
function cleanCaption(body) {
  const s = String(body || '').trim();
  if (!s) return null;
  if (s.length > 400) return null;
  if (/^\/9j\/|^iVBORw0|^data:image\//i.test(s)) return null;   // JPEG / PNG / data-URI
  if (/^[A-Za-z0-9+/=\s]{120,}$/.test(s)) return null;          // גוש base64 כללי
  return s;
}

// תיאור קצר לזיהוי כפילות: "רמי לוי, 87.40 ₪, 4.8.2026"
function labelOf(d) {
  return [d.vendor, money(d.total_with_tip, d.currency), heDate(d.date)].filter(Boolean).join(', ');
}

// אימוג'י על ההודעה — נחמד שיהיה, לא נורא אם לא.
// בקבלה שנמצאה בסריקה אין לנו אובייקט הודעה, ואז פשוט מדלגים.
async function react(msg, emoji) {
  if (!msg) return;
  try { await msg.react(emoji); } catch { /* גרסאות מסוימות לא תומכות */ }
}

// ── הסורק ───────────────────────────────────────────────────────────
//
//  וואטסאפ לא תמיד שולחת אירוע על תמונה שנשלחה לקבוצה — נתקלנו בזה
//  בפועל: הטקסט הגיע והתמונות לא. אז אחת לדקה סורקים את הקבוצה
//  ומטפלים בכל מדיה שטרם עובדה. האירועים נשארים המסלול המהיר,
//  והסריקה היא רשת הביטחון.
async function pollGroup(session) {
  if (session.state !== 'ready' || !session.groupId) return;

  const items = await scanGroupMedia(session.client, session.groupId, 15);
  if (!items.length) return;

  const fresh = items.filter((x) => {
    if (state.seenMessage(x.id)) return false;
    const ageHours = x.t ? (Date.now() - x.t * 1000) / 3600e3 : 0;
    return ageHours <= CATCHUP_HOURS;
  });

  if (!fresh.length) return;
  console.log(`🔍 הסריקה מצאה ${fresh.length} פריטים שטרם טופלו (מתוך ${items.length} בקבוצה)`);

  // מהישן לחדש, כדי שהשורות בגיליון יישמרו בסדר כרונולוגי
  for (const item of fresh.reverse()) {
    try {
      await handleReceipt(session, {
        msgId: item.id,
        caption: item.caption,
        kind: item.type,
        replyTo: null,                  // אין אובייקט הודעה — נשלח הודעה רגילה לקבוצה
        download: () => downloadReceiptById(session.client, item.id),
      });
    } catch (e) {
      console.error('הסריקה נכשלה על פריט:', e.message || e);
    }
  }
}

function startPolling(session) {
  const every = Math.max(20, Number(process.env.POLL_SECONDS || 60)) * 1000;
  console.log(`🔍 סורק את הקבוצה כל ${every / 1000} שניות (רשת ביטחון לאירועים שלא מגיעים)`);
  setInterval(() => {
    pollGroup(session).catch((e) => console.error('סריקה:', e.message || e));
  }, every);
}

function short(m) {
  return String(m || '').split('\n')[0].slice(0, 140);
}

// ── עלייה ───────────────────────────────────────────────────────────
function preflight() {
  const problems = [];
  if (!visionAvailable()) problems.push('חסר GEMINI_API_KEY — בלעדיו אי אפשר לקרוא קבלות.');
  if (!sheetsConfigured()) problems.push('חסרות הגדרות Google Sheets (GOOGLE_SHEET_ID / SERVICE_ACCOUNT_EMAIL / PRIVATE_KEY).');
  if (!GROUP_ID) problems.push('חסר RECEIPTS_GROUP_ID — הבוט יעלה במצב גילוי בלבד ולא יעבד כלום.');
  return problems;
}

async function boot() {
  console.log('⏳ מאתחל את בוט הקבלות...');
  console.log(`   node ${process.version} · AI: ${visionAvailable() ? 'gemini' : 'none'} · אחסון: ${storageMode()} · PORT=${PORT}`);
  console.log(`   מצב: ${ONLY_FROM_ME ? 'רק תמונות ששלחתי אני' : 'תמונות של כל חבר בקבוצה'}`);

  for (const p of preflight()) console.warn(`⚠️  ${p}`);

  const session = createSession({ groupId: GROUP_ID, onlyFromMe: ONLY_FROM_ME, onReceipt });
  global.__session = session;

  // הסורק מתחיל לרוץ ברגע שהחיבור מוכן
  session.client.on('ready', () => {
    setTimeout(() => pollGroup(session).catch(() => {}), 8000);   // סריקה ראשונה מיד
    startPolling(session);
  });

  await session.client.initialize().catch((e) => {
    console.error('❌ האתחול נכשל —', e.message || e);
    process.exit(1);
  });
}

// ── עמוד בריאות (בשביל הענן) — בלי שום מידע רגיש ────────────────────
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    up: Math.round((Date.now() - STARTED_AT) / 1000),
    wa: global.__session?.state || 'starting',
    processed,
    failed,
  }));
}).listen(PORT, () => console.log(`🌐 עמוד בריאות על פורט ${PORT}`));

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

boot().catch((e) => {
  console.error('❌ עלייה נכשלה:', e);
  process.exit(1);
});
