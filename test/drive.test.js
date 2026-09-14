// בדיקות שירות הדרייב: מידור בין עמיתים, והמסרים שעמית רואה.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DRIVE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-'));

const C = await import('../src/colleagues.js');
const S = await import('../src/drive-status.js');

test('לכל עמית מפתח וחתימות משלו', () => {
  const a = C.newSecret();
  const b = C.newSecret();
  assert.notEqual(C.pendingKeyOf(a), C.pendingKeyOf(b));
  assert.equal(C.pendingKeyOf(a).length, 32);
  // אותו קובץ, שני עמיתים — חתימות שונות. קישור של אחד לא עובד לשני.
  assert.notEqual(C.fileSig(a, 'FILE123456'), C.fileSig(b, 'FILE123456'));
  assert.equal(C.fileSig(a, 'FILE123456'), C.fileSig(a, 'FILE123456'));
  assert.match(C.fileSig(a, 'FILE123456'), /^[a-f0-9]{24}$/);
});

test('מפתח סימנייה מזהה רק את העמית שלו, ורק כשהוא פעיל', () => {
  const dani = { id: C.newId(), name: 'דני', secret: C.newSecret(), active: true };
  const rona = { id: C.newId(), name: 'רונה', secret: C.newSecret(), active: true };
  C.save([dani, rona]);

  assert.equal(C.byPendingKey(C.pendingKeyOf(dani.secret)).name, 'דני');
  assert.equal(C.byPendingKey(C.pendingKeyOf(rona.secret)).name, 'רונה');
  assert.equal(C.byPendingKey('0'.repeat(32)), null);
  assert.equal(C.byPendingKey(''), null);
  assert.equal(C.byPendingKey(null), null);

  C.save([{ ...dani, active: false }, rona]);
  assert.equal(C.byPendingKey(C.pendingKeyOf(dani.secret)), null, 'עמית מושהה לא נכנס');
});

test('הרישום נכתב בהרשאות מוגבלות ונקרא בחזרה', () => {
  C.save([{ id: 'c-aaaa1111', name: 'בדיקה', secret: 'x', active: true }]);
  assert.equal(C.list().length, 1);
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(C.DATA_DIR, 'colleagues.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test('מזהה עמית לא יכול לברוח מתיקיית הנתונים', () => {
  assert.throws(() => C.tenantDir('../../etc'));
  assert.throws(() => C.tenantDir('c/../x'));
  assert.ok(C.tenantDir('c-1a2b3c4d').includes('tenants'));
});

test('מזהה תיקייה מתוך קישור או מזהה נקי', () => {
  const id = '1clEP0_91GBTayn7d6H8wtgrC5WsrtsLy';
  assert.equal(C.folderIdFrom(`https://drive.google.com/drive/u/0/folders/${id}`), id);
  assert.equal(C.folderIdFrom(`https://drive.google.com/drive/folders/${id}?usp=sharing`), id);
  assert.equal(C.folderIdFrom(`https://drive.google.com/open?id=${id}`), id);
  assert.equal(C.folderIdFrom(id), id);
  assert.equal(C.folderIdFrom('לא קישור'), null);
});

test('גיבוב מפתח מתעלם מרווחים — כדי שהעתקה עם רווח לא תעקוף את החסימה', () => {
  assert.equal(C.keyHash('AIzaABC'), C.keyHash('  AIzaABC\n'));
  assert.notEqual(C.keyHash('AIzaABC'), C.keyHash('AIzaABD'));
});

test('שגיאות טכניות הופכות למשפט מובן', () => {
  assert.match(S.reasonOf(new Error('Gemini 429: quota')).text, /מכסת/);
  assert.equal(S.reasonOf(new Error('Gemini 429: quota')).retryable, true);
  assert.match(S.reasonOf(new Error('Gemini 400: API key not valid. Please pass a valid API key.')).text, /מפתח/);
  assert.equal(S.reasonOf(new Error('too-large')).retryable, false);
  assert.match(S.reasonOf(new Error('Sheets write 403: forbidden')).text, /הרשאת עריכה/);
  assert.match(S.reasonOf(new Error('fetch failed')).text, /זמנית/);
  assert.match(S.reasonOf(new Error('missing-gemini-key')).text, /מפתח/);
});

test('כל קובץ בתיקייה מופיע בסטטוס, גם כזה שלא טופל', () => {
  const files = [
    { id: 'a', name: 'ישן.jpg', createdTime: '2026-09-01T10:00:00Z' },
    { id: 'b', name: 'חדש.jpg', createdTime: '2026-09-10T10:00:00Z' },
    { id: 'c', name: 'תקוע.jpg', createdTime: '2026-09-05T10:00:00Z' },
    { id: 'd', name: 'ענק.pdf', createdTime: '2026-09-03T10:00:00Z' },
  ];
  const ledger = {
    a: { status: 'done', row: 4, label: 'גולדה · 86 ₪' },
    c: { status: 'failed', attempts: 3, reason: 'מפתח ה-AI לא תקין — צריך מפתח חדש' },
    d: { status: 'not-receipt', retryable: false, reason: 'הקובץ גדול מדי (עד 8MB)' },
  };
  const rows = S.statusRows(files, (id) => ledger[id] || null);

  assert.equal(rows.length, 4);
  assert.equal(rows[0][0], 'חדש.jpg', 'מהחדש לישן');
  assert.match(rows[0][2], /ממתין/);
  const byName = Object.fromEntries(rows.map((r) => [r[0], r]));
  assert.match(byName['ישן.jpg'][2], /נקלטה/);
  assert.match(byName['ישן.jpg'][3], /שורה 4/);
  assert.match(byName['תקוע.jpg'][2], /לא נקלטה/);
  assert.match(byName['תקוע.jpg'][3], /מפתח/);
  assert.match(byName['ענק.pdf'][2], /לא ניתן לקלוט/, 'קובץ גדול מדי אינו "לא קבלה"');
});

test('כישלון ראשון מוצג כ"ינוסה שוב", לא כתקלה', () => {
  const rows = S.statusRows([{ id: 'x', name: 'x.jpg' }], () => ({ status: 'failed', attempts: 1, reason: 'רשת' }));
  assert.match(rows[0][2], /ינוסה שוב/);
});

test('טביעת האצבע לא משתנה רק בגלל שעת עדכון', () => {
  const a = [['f.jpg', '01/09/2026 10:00', '⏳ ינוסה שוב', 'רשת', '11/09/2026 10:00']];
  const b = [['f.jpg', '01/09/2026 10:00', '⏳ ינוסה שוב', 'רשת', '11/09/2026 10:03']];
  assert.equal(S.fingerprint(a), S.fingerprint(b));
  const c = [['f.jpg', '01/09/2026 10:00', '✅ נקלטה', 'שורה 2', '11/09/2026 10:06']];
  assert.notEqual(S.fingerprint(a), S.fingerprint(c));
});

test('סיומת קובץ לקישור', () => {
  assert.equal(S.extOf('image/jpeg', 'WhatsApp Image.jpeg'), 'jpg');
  assert.equal(S.extOf('application/pdf', 'קבלה'), 'pdf');
  assert.equal(S.extOf('image/png', ''), 'png');
});
