// =====================================================================
//  drive-worker.js — עבודה על עמית אחד, בתהליך נפרד.
//
//  השירות מריץ את הקובץ הזה לכל עמית, עם הגיליון, התיקייה והמפתח
//  שלו בלבד בסביבה. למה תהליך נפרד ולא לולאה בזיכרון: מודולי הגיליון
//  וה-AI קוראים את המזהה ואת המפתח פעם אחת בטעינה. תהליך לכל עמית
//  נותן מידור אמיתי — שני עמיתים לא חולקים אפילו זיכרון — בלי לשכתב
//  קוד שגם הבוט הקיים נשען עליו.
//
//  פקודות:  ingest | pending | done | setup
//  התוצאה נכתבת לשורה אחת שמתחילה ב-@@RESULT. כל השאר הוא יומן.
// =====================================================================
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { listReceipts, download, tokenFor, SHEETS_SCOPE } from './drive.js';
import { readReceipt, visionAvailable } from './vision.js';
import { appendRow, rowFrom, findRow, pendingRows, markDone, setupSheet } from './sheets.js';
import * as ledger from './ledger.js';
import { fileSig, keyHash } from './colleagues.js';
import { reasonOf, statusRows, fingerprint, extOf, STATUS_TAB, STATUS_HEADERS } from './drive-status.js';

const ID = process.env.COLLEAGUE_ID || '';
const FOLDER = process.env.DRIVE_FOLDER_ID || '';
const SHEET = process.env.GOOGLE_SHEET_ID || '';
const SECRET = process.env.COLLEAGUE_SECRET || '';
const FILE_BASE = (process.env.FILE_BASE || '').replace(/\/+$/, '');
const cmd = process.argv[2];

const result = (obj) => process.stdout.write(`@@RESULT ${JSON.stringify(obj)}\n`);
const fail = (message) => { result({ ok: false, error: message }); process.exit(1); };

if (!ID || !FOLDER || !SHEET || !SECRET) fail('חסרים פרטי עמית בסביבה');

// המפתח שלך לעולם לא משמש קבלה של עמית. גם אם מישהו טעה והדביק
// אותו — עוצרים כאן, לפני שקריאה אחת יוצאת על חשבון המכסה שלך.
if (process.env.OWNER_KEY_HASH && keyHash(process.env.GEMINI_API_KEY) === process.env.OWNER_KEY_HASH) {
  fail('המפתח של עמית זהה למפתח של הבעלים — נחסם');
}

const TENANT_DIR = path.dirname(path.resolve(process.env.LEDGER_PATH || '.'));

// ── ingest ──────────────────────────────────────────────────────────
async function ingest() {
  const files = await listReceipts(FOLDER, { limit: 500 });
  const now = Date.now();
  const summary = { files: files.length, added: 0, duplicate: 0, notReceipt: 0, failed: 0 };

  for (const f of files) {
    const e = ledger.get(f.id);
    if (e && ledger.isSettled(e.status)) continue;
    if (e?.retryAt && e.retryAt > now) continue;   // עוד לא הגיע זמן הניסיון הבא
    await processFile(f, summary);
  }

  await writeStatus(files);
  return summary;
}

async function processFile(f, summary) {
  const at = Date.parse(f.createdTime) / 1000 || null;
  ledger.noticed(f.id, { at });
  const extra = { name: f.name };

  const failWith = (err) => {
    const r = reasonOf(err);
    ledger.failed(f.id, r.text, { retryable: r.retryable, extra });
    summary.failed++;
    console.error(`  ✗ ${f.name}: ${r.text}`);
  };

  let media;
  try { media = await download(f); } catch (e) { return failWith(e); }

  if (!visionAvailable()) return failWith(new Error('missing-gemini-key'));

  let data;
  try { data = await readReceipt(media.base64, media.mimetype, null); } catch (e) { return failWith(e); }

  if (!data.is_receipt) {
    ledger.mark(f.id, ledger.NOT_RECEIPT, { ...extra, reason: data.not_receipt_reason || 'לא נראית כמו קבלה' });
    summary.notReceipt++;
    return;
  }

  const label = [data.vendor, data.total_with_tip != null ? `${data.total_with_tip} ₪` : null].filter(Boolean).join(' · ');

  // אותה קבלה שהועלתה פעמיים (שני צילומים, שני קבצים) — נתפסת כאן
  let existing = null;
  try {
    existing = await findRow({ doc_number: data.doc_number, date: data.date, total: data.total_with_tip });
  } catch (e) {
    return failWith(e);
  }
  if (existing) {
    ledger.mark(f.id, ledger.DUPLICATE, { ...extra, row: existing, label });
    summary.duplicate++;
    return;
  }

  const url = `${FILE_BASE}/${fileSig(SECRET, f.id)}/${f.id}.${extOf(f.mimeType, f.name)}`;
  let row;
  try { row = await appendRow(rowFrom(data, url)); } catch (e) { return failWith(e); }

  ledger.mark(f.id, ledger.DONE, { ...extra, row, label });
  summary.added++;
  console.error(`  ✓ ${f.name} → שורה ${row} (${label})`);
}

// ── לשונית "קליטה" ──────────────────────────────────────────────────
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const FP_FILE = () => path.join(TENANT_DIR, 'status.fp');

async function sheetsCall(method, url, body) {
  const token = await tokenFor(SHEETS_SCOPE);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function ensureStatusTab() {
  const meta = await sheetsCall('GET', `${SHEETS}/${SHEET}?fields=sheets(properties(title,sheetId))`);
  if ((meta.sheets || []).some((s) => s.properties.title === STATUS_TAB)) return;

  const add = await sheetsCall('POST', `${SHEETS}/${SHEET}:batchUpdate`, {
    requests: [{ addSheet: { properties: { title: STATUS_TAB, rightToLeft: true, gridProperties: { frozenRowCount: 1 } } } }],
  });
  const gid = add.replies[0].addSheet.properties.sheetId;
  await sheetsCall('POST', `${SHEETS}/${SHEET}:batchUpdate`, {
    requests: [
      {
        repeatCell: {
          range: { sheetId: gid, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.94, blue: 0.95 } } },
          fields: 'userEnteredFormat(textFormat,backgroundColor)',
        },
      },
      ...[[0, 260], [1, 130], [2, 150], [3, 320], [4, 130]].map(([i, px]) => ({
        updateDimensionProperties: {
          range: { sheetId: gid, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: px }, fields: 'pixelSize',
        },
      })),
    ],
  });
}

async function writeStatus(files, { force = false } = {}) {
  const rows = statusRows(files, (id) => ledger.get(id));
  const fp = fingerprint(rows);
  let prev = null;
  try { prev = fs.readFileSync(FP_FILE(), 'utf8'); } catch { /* ראשונה */ }
  if (!force && prev === fp) return false;   // לא השתנה כלום — לא נוגעים בגיליון

  await ensureStatusTab();
  const range = (a) => encodeURIComponent(`${STATUS_TAB}!${a}`);
  await sheetsCall('POST', `${SHEETS}/${SHEET}/values/${range('A:E')}:clear`, {});
  await sheetsCall('PUT', `${SHEETS}/${SHEET}/values/${range('A1')}?valueInputOption=RAW`, {
    values: [STATUS_HEADERS, ...rows],
  });

  fs.mkdirSync(TENANT_DIR, { recursive: true });
  fs.writeFileSync(FP_FILE(), fp);
  return true;
}

// ── setup: הכנת גיליון חדש של עמית ───────────────────────────────────
async function setup() {
  const info = await setupSheet();   // לשונית "הוצאות", כותרות, עיצוב, כללי השדות

  // גיליון חדש נולד עם לשונית ריקה ("Sheet1" / "גיליון1"). אם היא
  // באמת ריקה — מסירים אותה, כדי שהעמית ייפתח ישר על הטבלה.
  const meta = await sheetsCall('GET', `${SHEETS}/${SHEET}?fields=sheets(properties(title,sheetId))`);
  for (const s of meta.sheets || []) {
    const { title, sheetId } = s.properties;
    if (!/^(Sheet\d+|גיליון\d+)$/.test(title)) continue;
    const vals = await sheetsCall('GET', `${SHEETS}/${SHEET}/values/${encodeURIComponent(`'${title}'!A1:Z200`)}`);
    if ((vals.values || []).length) continue;   // יש בה תוכן — לא נוגעים
    await sheetsCall('POST', `${SHEETS}/${SHEET}:batchUpdate`, { requests: [{ deleteSheet: { sheetId } }] });
  }

  await writeStatus(await listReceipts(FOLDER, { limit: 500 }), { force: true });
  return { url: info.url };
}

// ── הרצה ────────────────────────────────────────────────────────────
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

try {
  if (cmd === 'ingest') result({ ok: true, ...(await ingest()) });
  else if (cmd === 'pending') result({ ok: true, rows: await pendingRows() });
  else if (cmd === 'done') {
    const body = await readStdin();
    result({ ok: true, ...(await markDone(Array.isArray(body.rows) ? body.rows.slice(0, 100) : [])) });
  } else if (cmd === 'setup') result({ ok: true, ...(await setup()) });
  else fail(`פקודה לא מוכרת: ${cmd}`);
} catch (e) {
  fail(String(e.message || e).slice(0, 300));
}
