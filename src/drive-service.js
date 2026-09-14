// =====================================================================
//  drive-service.js — שירות קליטת הקבלות של העמיתים.
//
//  רץ במכולה משלו, לצד בוט הוואטסאפ ובלי לגעת בו: תהליך אחר, קובץ
//  הגדרות אחר, ונתונים בתיקייה אחרת. אם השירות הזה נופל — הבוט שלך
//  ממשיך כרגיל, וגם להפך.
//
//  מה הוא עושה:
//   · כל כמה דקות עובר על העמיתים, ולכל אחד מריץ קליטה בתהליך נפרד
//   · מגיש לסימנייה של כל עמית את השורות שלו (/pending) ומסמן ✓ (/done)
//   · מגיש את קבצי הקבלות מהדרייב של העמית, בקישור חתום
//
//  קובץ ההגדרות של השירות לא מכיל את מפתח ה-AI שלך. זו לא רק הקפדה:
//  כך אין שום דרך — גם בטעות — שקבלה של עמית תיקרא על חשבון המכסה שלך.
// =====================================================================
import 'dotenv/config';
import http from 'http';
import { Readable } from 'stream';
import * as colleagues from './colleagues.js';
import { fileMeta, openFile } from './drive.js';
import { runWorker } from './drive-runner.js';

const PORT = Number(process.env.PORT || 3200);
const PUBLIC = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || '').trim();
const POLL_MIN = Math.max(1, Number(process.env.POLL_MINUTES || 3));
const STARTED = Date.now();

// ── הסבב ────────────────────────────────────────────────────────────
const health = { lastCycleAt: null, lastCycleMs: null, running: false, lastErrors: {} };

async function cycle() {
  if (health.running) return;   // סבב קודם עוד רץ — לא מתחילים שני במקביל
  health.running = true;
  const t0 = Date.now();

  let list = [];
  try { list = colleagues.active(); } catch (e) { console.error(`❌ ${e.message}`); }

  for (const c of list) {
    const r = await runWorker(c, 'ingest');
    if (!r.ok) {
      health.lastErrors[c.id] = r.error;
      console.log(`[${c.name || c.id}] ❌ ${r.error}`);
    } else {
      delete health.lastErrors[c.id];
      if (r.added || r.failed || r.duplicate || r.notReceipt) {
        console.log(`[${c.name || c.id}] ${r.files} קבצים · נוספו ${r.added} · כפולות ${r.duplicate} · לא קבלה ${r.notReceipt} · נכשלו ${r.failed}`);
      }
    }
  }

  health.lastCycleAt = new Date().toISOString();
  health.lastCycleMs = Date.now() - t0;
  health.running = false;
}

// ── HTTP ────────────────────────────────────────────────────────────
function cors(req, extra = {}) {
  if (!ALLOW_ORIGIN || req.headers.origin !== ALLOW_ORIGIN) return extra;
  return { ...extra, 'Access-Control-Allow-Origin': ALLOW_ORIGIN, Vary: 'Origin' };
}

function json(req, res, status, obj) {
  res.writeHead(status, cors(req, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }));
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req, {
      'Access-Control-Max-Age': '86400',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }));
    res.end();
    return;
  }

  // השורות הממתינות של עמית אחד — לפי המפתח שבסימנייה שלו
  if (url.pathname === '/pending' || url.pathname === '/done') {
    const c = colleagues.byPendingKey(url.searchParams.get('k'));
    if (!c) return json(req, res, 403, { error: 'forbidden' });

    if (url.pathname === '/pending') {
      const r = await runWorker(c, 'pending', { timeoutMs: 60e3 });
      return r.ok ? json(req, res, 200, { ok: true, count: r.rows.length, rows: r.rows })
        : json(req, res, 500, { error: r.error });
    }

    if (req.method !== 'POST') return json(req, res, 405, { error: 'method' });
    let body;
    try { body = await readBody(req); } catch (e) { return json(req, res, 400, { error: e.message }); }
    const r = await runWorker(c, 'done', { input: body, timeoutMs: 60e3 });
    return r.ok ? json(req, res, 200, r) : json(req, res, 500, { error: r.error });
  }

  // קובץ קבלה: /f/<עמית>/<חתימה>/<קובץ>.<סיומת>
  const m = url.pathname.match(/^\/f\/([a-z0-9-]{3,40})\/([a-f0-9]{24})\/([A-Za-z0-9_-]{10,})\.[a-z0-9]{2,5}$/);
  if (m) {
    const [, id, sig, fileId] = m;
    const c = colleagues.byId(id);
    // חתימה לא תקינה ועמית לא קיים מחזירים אותה תשובה — כדי שלא
    // אפשר יהיה לגלות מזהי עמיתים בניחוש
    if (!c || c.active === false || !colleagues.sameSecret(colleagues.fileSig(c.secret, fileId), sig)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('לא נמצא');
    }
    try {
      // הגנה נוספת: הקובץ חייב לשבת בתיקייה של אותו עמית
      const meta = await fileMeta(fileId);
      if (!meta || meta.trashed || !(meta.parents || []).includes(c.folderId)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('לא נמצא');
      }
      const drive = await openFile(fileId);
      res.writeHead(200, cors(req, {
        'Content-Type': meta.mimeType || 'application/octet-stream',
        ...(meta.size ? { 'Content-Length': meta.size } : {}),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.name || `${fileId}`)}`,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      }));
      if (req.method === 'HEAD') return res.end();
      Readable.fromWeb(drive.body).pipe(res);
    } catch (e) {
      console.error(`קובץ ${fileId}: ${e.message}`);
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('הקובץ לא זמין כרגע');
    }
    return;
  }

  // עמוד בריאות — בלי שמות, בלי מפתחות
  let count = 0;
  try { count = colleagues.active().length; } catch { /* מדווח ביומן */ }
  json(req, res, 200, {
    ok: true,
    service: 'receipts-drive',
    up: Math.round((Date.now() - STARTED) / 1000),
    colleagues: count,
    pollMinutes: POLL_MIN,
    lastCycleAt: health.lastCycleAt,
    lastCycleMs: health.lastCycleMs,
    failing: Object.keys(health.lastErrors).length,
  });
});

server.listen(PORT, () => {
  console.log(`📁 שירות הדרייב מאזין על ${PORT} · סבב כל ${POLL_MIN} דק' · ${PUBLIC || '(אין כתובת ציבורית)'}`);
  if (!PUBLIC.startsWith('https://')) console.log('⚠️  PUBLIC_BASE_URL חסר או לא https — קישורי הקבלות לא יעבדו');
  if (!process.env.OWNER_KEY_HASH) console.log('⚠️  OWNER_KEY_HASH לא מוגדר — אין הגנה מפני שימוש במפתח שלך');
  setTimeout(() => cycle().catch((e) => console.error('סבב:', e.message)), 15e3);
  setInterval(() => cycle().catch((e) => console.error('סבב:', e.message)), POLL_MIN * 60e3);
});
