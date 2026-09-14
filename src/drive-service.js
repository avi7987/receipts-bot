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
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import * as colleagues from './colleagues.js';
import { fileMeta, openFile } from './drive.js';
import { runWorker } from './drive-runner.js';
import { register, OnboardError, makeLimiter } from './onboard.js';

// ── דף ההרשמה ───────────────────────────────────────────────────────
//  פתוח רק למי שיש לו את קוד הצוות. בלי קוד, כל מי שמגיע לכתובת
//  היה יכול להירשם — וכל נרשם צורך ממכסת ה-API של חשבון השירות,
//  שמשרת גם את בוט הוואטסאפ. בלי JOIN_CODE מוגדר, ההרשמה כבויה.
const JOIN_CODE = (process.env.JOIN_CODE || '').trim();
const page = (file) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), file), 'utf8')
  .replace('__SA_EMAIL__', process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '');
const JOIN_HTML = page('join.html');
//  המדריך פתוח בלי קוד: אין בו שום דבר שמאפשר להירשם — רק הסבר.
//  כך אפשר לשלוח אותו לכל מי שמתעניין, בלי לחשוף את קישור ההרשמה.
const GUIDE_HTML = page('guide.html');
const allowJoin = makeLimiter();

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'none'",
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "script-src 'unsafe-inline'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; '),
};

const NO_CODE_PAGE = `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>הרשמה</title>
<body style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:15vh auto;padding:0 20px;line-height:1.7;color:#263238;background:#F3F5F7">
<h1 style="font-size:24px">הקישור לא שלם</h1><p>לדף ההרשמה נכנסים רק מהקישור המלא שקיבלת בקבוצת הצוות. בקש/י אותו ממפעיל השירות.</p></body></html>`;

const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

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

  // ── המדריך ──
  if (url.pathname === '/guide' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, PAGE_HEADERS);
    return res.end(req.method === 'HEAD' ? undefined : GUIDE_HTML);
  }

  // ── הרשמה עצמית ──
  if (url.pathname === '/join') {
    const codeOk = (c) => !!JOIN_CODE && colleagues.sameSecret(c, JOIN_CODE);

    if (req.method === 'GET') {
      const ok = codeOk(url.searchParams.get('code'));
      res.writeHead(ok ? 200 : 403, PAGE_HEADERS);
      return res.end(ok ? JOIN_HTML : NO_CODE_PAGE);
    }
    if (req.method !== 'POST') return json(req, res, 405, { error: 'method' });

    if (!allowJoin(clientIp(req))) {
      return json(req, res, 429, { ok: false, error: 'יותר מדי ניסיונות. נסה שוב בעוד רבע שעה.' });
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return json(req, res, 415, { ok: false, error: 'בקשה לא תקינה' });
    }

    let body;
    try { body = await readBody(req, 8 * 1024); } catch { return json(req, res, 400, { ok: false, error: 'בקשה לא תקינה' }); }
    if (!codeOk(body.code)) return json(req, res, 403, { ok: false, error: 'הקישור לא שלם. היכנס מהקישור המלא שקיבלת.' });

    try {
      const r = await register({ name: body.name, folder: body.folder, key: body.key });
      console.log(`📝 ${{ created: 'נרשם/ה', recovered: 'שחזר/ה סימנייה', updated: 'החליף/ה מפתח' }[r.status]}: ${r.colleague.name} (${r.colleague.id})`);
      return json(req, res, 200, {
        ok: true,
        status: r.status,
        name: r.colleague.name,
        sheetUrl: r.sheetUrl,
        bookmarklet: r.bookmarklet.text,
        warning: r.warning || null,
      });
    } catch (e) {
      if (e instanceof OnboardError) return json(req, res, 400, { ok: false, error: e.message, field: e.field });
      console.error('הרשמה נכשלה:', e.message || e);
      return json(req, res, 500, { ok: false, error: 'משהו השתבש בצד שלנו. נסה שוב בעוד כמה דקות.' });
    }
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
  console.log(JOIN_CODE ? '📝 הרשמה עצמית פעילה (/join?code=…)' : '📝 הרשמה עצמית כבויה — אין JOIN_CODE');
  setTimeout(() => cycle().catch((e) => console.error('סבב:', e.message)), 15e3);
  setInterval(() => cycle().catch((e) => console.error('סבב:', e.message)), POLL_MIN * 60e3);
});
