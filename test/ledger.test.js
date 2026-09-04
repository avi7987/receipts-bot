// בדיקות היומן. הרעיון המרכזי שנבדק כאן: קבלה שנכשלה חייבת להישאר
// פתוחה עד שמישהו יטפל בה — לא להיעלם ולא להיספר כמוצלחת.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
process.env.LEDGER_PATH = path.join(dir, 'ledger.json');
process.env.STATE_PATH = path.join(dir, 'processed.json');

// כותבים קובץ ישן לפני הטעינה, כדי לבדוק את ההגירה
fs.writeFileSync(process.env.STATE_PATH, JSON.stringify({
  msgIds: ['old-1', 'old-2'],
  hashes: { abc123: { label: 'קפה, 60 ₪', row: 9 } },
}));

const L = await import('../src/ledger.js');

test('הגירה מ-processed.json מסמנת את הישן כמטופל', () => {
  assert.equal(L.settled('old-1'), true);
  assert.equal(L.settled('old-2'), true);
  const byHash = L.byHash('abc123');
  assert.ok(byHash);
  assert.equal(byHash.row, 9);
});

test('הודעה חדשה נרשמת כממתינה ולכן נחשבת פתוחה', () => {
  L.noticed('m1', { chat: 'g@g.us', at: 1000 });
  assert.equal(L.settled('m1'), false);
  assert.equal(L.open().some((e) => e.id === 'm1'), true);
});

test('כישלון נשאר פתוח ומקבל זמן לניסיון חוזר', () => {
  L.noticed('m2');
  L.failed('m2', 'מכסת ה-AI נגמרה');
  const e = L.get('m2');
  assert.equal(e.status, L.FAILED);
  assert.equal(L.settled('m2'), false);
  assert.match(e.reason, /מכסת/);
  assert.ok(e.retryAt > Date.now());
  // עוד לא הגיע הזמן — לא אמור לחזור ברשימת הניסיונות
  assert.equal(L.dueForRetry().some((x) => x.id === 'm2'), false);
  assert.equal(L.dueForRetry(e.retryAt + 1).some((x) => x.id === 'm2'), true);
});

test('ההשהיה גדלה בין ניסיונות', () => {
  L.noticed('m3');
  L.failed('m3', 'רשת');
  const first = L.get('m3').retryAt - Date.now();
  L.failed('m3', 'רשת');
  const second = L.get('m3').retryAt - Date.now();
  assert.ok(second > first, `${second} אמור להיות גדול מ-${first}`);
  assert.equal(L.get('m3').attempts, 2);
});

test('כישלון שאין טעם לנסות שוב נסגר', () => {
  L.noticed('m4');
  L.failed('m4', 'זו לא קבלה', { retryable: false });
  assert.equal(L.settled('m4'), true);
  assert.equal(L.get('m4').retryAt, null);
});

test('הצלחה סוגרת את הרשומה', () => {
  L.noticed('m5');
  L.mark('m5', L.DONE, { row: 12, label: 'yellow, 283 ₪' });
  assert.equal(L.settled('m5'), true);
  assert.equal(L.open().some((e) => e.id === 'm5'), false);
});

test('הסיכום סופר לפי מצב ומצביע על הפתוחה הוותיקה ביותר', () => {
  const s = L.summary();
  assert.equal(s.done >= 1, true);
  assert.equal(s.failed >= 2, true);
  assert.ok(s.oldestOpen, 'אמורה להיות רשומה פתוחה');
  // m1 נרשמה ראשונה מבין הפתוחות
  assert.equal(s.oldestOpen.id, 'm1');
});

test('שכחה מאפשרת לטפל מחדש', () => {
  assert.equal(L.forget('m5'), true);
  assert.equal(L.get('m5'), null);
  assert.equal(L.forget('לא-קיים'), false);
});

test('היומן שורד טעינה מחדש מהדיסק', async () => {
  const raw = JSON.parse(fs.readFileSync(process.env.LEDGER_PATH, 'utf8'));
  assert.equal(raw.entries.m2.status, L.FAILED);
  assert.match(raw.entries.m2.reason, /מכסת/);
});
