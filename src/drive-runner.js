// =====================================================================
//  drive-runner.js — מריץ עבודה על עמית אחד בתהליך נפרד.
//
//  משותף לשירות (הסבב, /pending, /done) ולכלי ההוספה של עמיתים.
// =====================================================================
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as colleagues from './colleagues.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, 'drive-worker.js');
const PUBLIC = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

// ── הרצת עבודה על עמית ──────────────────────────────────────────────
//  הסביבה של התהליך נבנית מאפס ולא מועתקת מהשירות: רק מה שהעמית
//  הזה צריך, ורק שלו.
export function envFor(c) {
  const dir = colleagues.tenantDir(c.id);
  return {
    PATH: process.env.PATH,
    NODE_ENV: process.env.NODE_ENV || 'production',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
    GEMINI_MODEL: process.env.GEMINI_MODEL || '',
    OWNER_KEY_HASH: process.env.OWNER_KEY_HASH || '',
    DRIVE_DATA_DIR: colleagues.DATA_DIR,

    COLLEAGUE_ID: c.id,
    COLLEAGUE_SECRET: c.secret,
    DRIVE_FOLDER_ID: c.folderId,
    GOOGLE_SHEET_ID: c.sheetId,
    GOOGLE_SHEET_TAB: 'הוצאות',
    GEMINI_API_KEY: c.geminiKey || '',
    LEDGER_PATH: path.join(dir, 'ledger.json'),
    STATE_PATH: path.join(dir, 'processed.json'),   // לא קיים — אין ממה להגר
    FILE_BASE: `${PUBLIC}/f/${c.id}`,
  };
}

export function runWorker(c, cmd, { input = null, timeoutMs = 10 * 60e3 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, cmd], {
      env: envFor(c),
      cwd: path.join(here, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const tag = `[${c.name || c.id}]`;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, error: 'העבודה ארכה יותר מדי ונעצרה' });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => {
      for (const line of String(d).split('\n').filter(Boolean)) console.log(`${tag} ${line}`);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const lines = out.split('\n');
      for (const l of lines) if (l && !l.startsWith('@@RESULT ')) console.log(`${tag} ${l}`);
      const last = lines.filter((l) => l.startsWith('@@RESULT ')).pop();
      try {
        resolve(last ? JSON.parse(last.slice(9)) : { ok: false, error: 'אין תוצאה מהתהליך' });
      } catch {
        resolve({ ok: false, error: 'תוצאה לא קריאה מהתהליך' });
      }
    });

    if (input) child.stdin.end(JSON.stringify(input));
    else child.stdin.end();
  });
}

