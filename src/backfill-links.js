// =====================================================================
//  backfill-links.js — מוסיף קישור הורדה לשורות שנקלטו לפני שההגשה
//  מהשרת הופעלה. ההתאמה לפי תאריך וסכום, ששניהם בשם הקובץ המקומי.
//
//  הרצה (בתוך הקונטיינר):  node src/backfill-links.js
//  בטוח להרצה חוזרת — שורה שכבר יש בה קישור לא נגעת.
// =====================================================================
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { saveForServing, servingConfigured } from './storage.js';

const DIR = process.env.RECEIPTS_DIR || './receipts';
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TAB = process.env.GOOGLE_SHEET_TAB || 'הוצאות';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

if (!servingConfigured()) {
  console.error('❌ חסר PUBLIC_BASE_URL או LINK_SECRET');
  process.exit(1);
}

// ── אימות ───────────────────────────────────────────────────────────
const b64 = (s) => Buffer.from(s).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const claim = b64(JSON.stringify({
  iss: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  scope: 'https://www.googleapis.com/auth/spreadsheets',
  aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
}));
const sg = crypto.createSign('RSA-SHA256');
sg.update(`${head}.${claim}`);
const jwt = `${head}.${claim}.${b64(sg.sign((process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n')))}`;
const TOKEN = (await (await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
})).json()).access_token;
if (!TOKEN) { console.error('❌ אימות נכשל'); process.exit(1); }

const auth = { Authorization: `Bearer ${TOKEN}` };
const jsonAuth = { ...auth, 'Content-Type': 'application/json' };
const R = (a) => encodeURIComponent(`${TAB}!${a}`);

// ── ניקוי מיקום סיכום ישן (עבר מ-I/J ל-J/K) ─────────────────────────
await fetch(`${API}/${SHEET_ID}/values/${R('I1:I4')}:clear`, { method: 'POST', headers: jsonAuth, body: '{}' });

// ── השורות והקבצים ──────────────────────────────────────────────────
const rows = ((await (await fetch(`${API}/${SHEET_ID}/values/${R('A2:H')}`, { headers: auth })).json()).values) || [];
console.log(`שורות בגיליון: ${rows.length}`);

let files = [];
try {
  files = fs.readdirSync(DIR).filter((f) => /\.(jpe?g|png|pdf|webp)$/i.test(f));
} catch {
  console.error(`❌ אין תיקייה ${DIR}`);
  process.exit(1);
}
console.log(`קבצים מקומיים: ${files.length}\n`);

// שם הקובץ: 2026-08-19_קפה-גרציאני_60_abc123.jpg
const parsed = files.map((f) => {
  const parts = f.replace(/\.[^.]+$/, '').split('_');
  const nums = parts.filter((p) => /^\d+(\.\d+)?$/.test(p)).map(Number);
  return {
    file: f,
    date: /^\d{4}-\d{2}-\d{2}$/.test(parts[0]) ? parts[0] : null,
    total: nums.length ? nums[nums.length - 1] : null,
  };
});

const toIso = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : String(s || '').trim();
};
const numOf = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[^\d.,-]/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const safe = (s) => String(s || '').trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40);

const updates = [];
const used = new Set();

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const rowNum = i + 2;
  if (String(r[7] || '').trim()) { console.log(`  ${rowNum}: כבר יש קישור`); continue; }

  const date = toIso(r[0]);
  const total = numOf(r[2]);
  const hit = parsed.find((p) => !used.has(p.file) && p.date === date
    && p.total !== null && total !== null && Math.abs(p.total - total) < 0.005);

  if (!hit) { console.log(`  ${rowNum}: ${date} ${total} — אין תמונה תואמת`); continue; }

  const full = path.join(DIR, hit.file);
  const ext = path.extname(hit.file).toLowerCase();
  const mime = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg';
  const display = `${date}${r[1] ? `_${safe(r[1])}` : ''}_${total}${ext}`;

  const served = saveForServing(fs.readFileSync(full).toString('base64'), mime, display);
  if (!served) { console.log(`  ${rowNum}: שמירה נכשלה`); continue; }

  used.add(hit.file);
  updates.push({ range: `${TAB}!H${rowNum}`, values: [[`=HYPERLINK("${served.url}";"📎 פתח")`]] });
  console.log(`  ${rowNum}: ✅ ${display}`);
}

if (!updates.length) { console.log('\nאין מה לעדכן.'); process.exit(0); }

const res = await fetch(`${API}/${SHEET_ID}/values:batchUpdate`, {
  method: 'POST', headers: jsonAuth,
  body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }),
});
console.log(`\nכתיבת ${updates.length} קישורים: ${res.ok ? '✅ בוצע' : '❌ ' + (await res.text()).slice(0, 200)}`);
