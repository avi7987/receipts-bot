// =====================================================================
//  link-google.js — קורא את קובץ ה-JSON של חשבון השירות
//  ומכניס את שני הערכים ל-.env, בלי שתצטרך להעתיק ידנית.
//
//  הרצה:  npm run link-google
//         npm run link-google -- "C:\נתיב\לקובץ.json"
//
//  המפתח הפרטי לא מודפס למסך ולא נשלח לשום מקום — הוא עובר
//  מהקובץ ישירות ל-.env שנמצא אצלך במחשב.
// =====================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';

const ENV_FILE = path.resolve('./.env');

// ── איתור הקובץ ─────────────────────────────────────────────────────
function candidateDirs() {
  const home = os.homedir();
  return [
    path.join(home, 'Downloads'),
    path.join(home, 'OneDrive', 'Downloads'),
    path.join(home, 'הורדות'),
    home,
  ].filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

function isServiceAccount(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j.type === 'service_account' && j.client_email && j.private_key ? j : null;
  } catch {
    return null;
  }
}

function findNewest() {
  const found = [];
  for (const dir of candidateDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.json')) continue;
      const full = path.join(dir, n);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile() || st.size > 32 * 1024) continue;
      const j = isServiceAccount(full);
      if (j) found.push({ full, mtime: st.mtimeMs, json: j });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}

// ── כתיבה ל-.env ────────────────────────────────────────────────────
function setEnv(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
}

// ── ריצה ────────────────────────────────────────────────────────────
const arg = process.argv[2];
let picked;

if (arg) {
  const json = isServiceAccount(path.resolve(arg));
  if (!json) {
    console.error(`❌ הקובץ לא נמצא, או שהוא לא קובץ חשבון שירות תקין:\n   ${arg}`);
    process.exit(1);
  }
  picked = { full: path.resolve(arg), json };
} else {
  const found = findNewest();
  if (!found.length) {
    console.error('❌ לא מצאתי קובץ חשבון שירות בתיקיית ההורדות.');
    console.error('   הרץ שוב עם הנתיב המלא לקובץ, למשל:');
    console.error('   npm run link-google -- "C:\\Users\\...\\Downloads\\receipts-123.json"');
    process.exit(1);
  }
  picked = found[0];
  if (found.length > 1) {
    console.log(`ℹ️  נמצאו ${found.length} קבצים מתאימים — נבחר החדש ביותר.`);
  }
}

if (!fs.existsSync(ENV_FILE)) {
  console.error('❌ אין קובץ .env בתיקייה הזו. הרץ קודם:  cp .env.example .env');
  process.exit(1);
}

const { client_email, private_key, project_id } = picked.json;

let env = fs.readFileSync(ENV_FILE, 'utf8');
env = setEnv(env, 'GOOGLE_SERVICE_ACCOUNT_EMAIL', client_email);
// שורות חדשות נשמרות כ-\n ספרותי, ובמרכאות — כך dotenv קורא אותן נכון
env = setEnv(env, 'GOOGLE_PRIVATE_KEY', `"${private_key.replace(/\n/g, '\\n')}"`);
fs.writeFileSync(ENV_FILE, env);

console.log(`\n✅ הקובץ נקרא:  ${path.basename(picked.full)}`);
console.log(`   פרויקט:      ${project_id || '?'}`);
console.log('   המפתח הפרטי הוכנס ל-.env (לא מודפס כאן, ובצדק).\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  נשאר שלב אחד ידני — שיתוף הגיליון:');
console.log('');
console.log('  1. פתח את הגיליון ב-Google Sheets');
console.log('  2. לחץ על כפתור "שיתוף" הכחול (למעלה מימין)');
console.log('  3. הדבק את הכתובת הזו:');
console.log('');
console.log(`     ${client_email}`);
console.log('');
console.log('  4. שנה את ההרשאה ל-"עורך" (Editor)');
console.log('  5. בטל את הסימון "שליחת התראה" אם מופיע, ולחץ "שיתוף"');
console.log('');
console.log('  ואז הרץ:  npm run check');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
