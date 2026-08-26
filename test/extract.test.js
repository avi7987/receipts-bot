// בדיקות ליבה: כל מה שאפשר לבדוק בלי לקרוא ל-AI ובלי וואטסאפ.
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize, num, isoDate, dateLooksSane, extractJson, clockTime, guestCount } from '../src/vision.js';
import { rowFrom, HEADERS, colLetter, hebField, normDoc, numOf, sameDate } from '../src/sheets.js';
import {
  money, heDate, receiptMessage, errorMessage, followUpSteps, stepQuestion,
  parseYesNo, carNumber,
} from '../src/format.js';

const today = () => new Date().toISOString().slice(0, 10);

// ── המרת מספרים ─────────────────────────────────────────────────────
test('num מנקה סימני מטבע ופסיקי אלפים', () => {
  assert.equal(num('1,234.50 ₪'), 1234.5);
  assert.equal(num('₪87.40'), 87.4);
  assert.equal(num(42), 42);
  assert.equal(num(''), null);
  assert.equal(num('לא מספר'), null);
  assert.equal(num(null), null);
});

// ── תאריכים ─────────────────────────────────────────────────────────
test('isoDate מקבל רק תאריך תקין בפורמט ISO', () => {
  assert.equal(isoDate('2026-08-04'), '2026-08-04');
  assert.equal(isoDate('2026-08-04T10:00:00Z'), '2026-08-04');
  assert.equal(isoDate('04/08/2026'), null);   // לא ISO — המודל היה אמור להמיר
  assert.equal(isoDate('2026-02-31'), null);   // תאריך שלא קיים
  assert.equal(isoDate(null), null);
});

test('dateLooksSane פוסל עתיד רחוק ועבר עתיק', () => {
  const iso = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
  assert.equal(dateLooksSane(iso(-3)), true);
  assert.equal(dateLooksSane(iso(-400)), true);
  assert.equal(dateLooksSane(iso(30)), false);     // חודש קדימה = קריאה שגויה
  assert.equal(dateLooksSane(iso(-900)), false);   // לפני יותר משנתיים
});

// ── חילוץ ה-JSON מהתשובה של המודל ───────────────────────────────────
test('extractJson קורא JSON נקי, עטוף בגדרות, או משובץ בטקסט', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('בבקשה:\n{"a":1}\nבהצלחה'), { a: 1 });
  assert.equal(extractJson('בלי שום JSON'), null);
  assert.equal(extractJson(''), null);
});

// ── normalize ───────────────────────────────────────────────────────
const raw = {
  is_receipt: true,
  date: today(),
  total: '444.00',
  doc_number: '0038412',
  tip_extra: null,
  currency: 'ils',
  vendor: 'מסעדת הגליל בע"מ',
  uncertain: [],
};

test('normalize מנקה ומטפס את שלושת השדות', () => {
  const r = normalize(raw);
  assert.equal(r.date, today());
  assert.equal(r.total, 444);
  assert.equal(r.doc_number, '0038412');   // אפס מוביל נשמר כמחרוזת
  assert.equal(r.currency, 'ILS');         // אותיות גדולות
  assert.deepEqual(r.uncertain, []);
});

test('normalize מחשב סכום כולל טיפ שנמסר במזומן', () => {
  const r = normalize({ ...raw, tip_extra: '50' });
  assert.equal(r.total, 444);              // מה שנגבה בפועל
  assert.equal(r.tip_extra, 50);
  assert.equal(r.total_with_tip, 494);     // מה שנכנס לטבלה
});

test('בלי טיפ — הסכום הכולל זהה לסכום הקבלה', () => {
  const r = normalize(raw);
  assert.equal(r.total_with_tip, 444);
  assert.equal(r.tip_extra, null);
});

test('טיפ אפס או שלילי נזרק', () => {
  assert.equal(normalize({ ...raw, tip_extra: 0 }).tip_extra, null);
  assert.equal(normalize({ ...raw, tip_extra: -20 }).tip_extra, null);
  assert.equal(normalize({ ...raw, tip_extra: -20 }).total_with_tip, 444);
});

test('חיבור הטיפ לא גורר שגיאת עשרוניות', () => {
  const r = normalize({ ...raw, total: 87.1, tip_extra: 12.2 });
  assert.equal(r.total_with_tip, 99.3);    // ולא 99.30000000000001
});

test('normalize מסמן שדות חסרים כלא-ודאיים', () => {
  const r = normalize({ ...raw, date: null, total: null, doc_number: null });
  assert.ok(r.uncertain.includes('date'));
  assert.ok(r.uncertain.includes('total'));
  assert.ok(r.uncertain.includes('doc_number'));
  assert.equal(r.total_with_tip, null);
});

test('normalize תופס תאריך לא הגיוני', () => {
  const future = new Date(Date.now() + 60 * 86400e3).toISOString().slice(0, 10);
  assert.ok(normalize({ ...raw, date: future }).uncertain.includes('date'));
});

test('normalize מכבד is_receipt=false', () => {
  const r = normalize({ is_receipt: false, not_receipt_reason: 'זו תמונה של חתול' });
  assert.equal(r.is_receipt, false);
  assert.equal(r.not_receipt_reason, 'זו תמונה של חתול');
});

test('normalize מכריח קטגוריה מהרשימה הסגורה', () => {
  assert.equal(normalize({ ...raw, category: 'המצאה כלשהי' }).category, 'אחר');
  assert.equal(normalize({ ...raw, category: 'חניה' }).category, 'חניה');
  assert.equal(normalize(raw).category, 'אחר');          // בלי קטגוריה בכלל
});

// ── בניית השורה לגיליון ─────────────────────────────────────────────
test('הטבלה היא 13 עמודות בסדר הנכון', () => {
  assert.deepEqual(HEADERS, ['תאריך', 'שעה', 'ספק', 'סכום כולל', 'מספר חשבונית', 'קטגוריה', 'סועדים', 'לקוח', 'אורחים', 'רכב חלופי', 'הוזן במערכת', 'סומן בתאריך', 'קבלה']);
});

test('rowFrom מייצר שורה באורך הכותרות', () => {
  assert.equal(rowFrom(normalize(raw)).length, HEADERS.length);
});

test('rowFrom כותב את הסכום כולל הטיפ, כמספר', () => {
  const row = rowFrom(normalize({ ...raw, tip_extra: 50 }));
  const v = row[HEADERS.indexOf('סכום כולל')];
  assert.equal(typeof v, 'number');
  assert.equal(v, 494);
});

test('rowFrom שומר אפסים מובילים במספר החשבונית', () => {
  const row = rowFrom(normalize(raw));
  assert.equal(row[HEADERS.indexOf('מספר חשבונית')], "'0038412");
});

test('rowFrom מייצר תיבת סימון ריקה וחותמת ריקה', () => {
  const row = rowFrom(normalize(raw));
  assert.equal(row[HEADERS.indexOf('הוזן במערכת')], false);
  assert.equal(row[HEADERS.indexOf('סומן בתאריך')], '');
});

test('rowFrom כותב ספק וקטגוריה', () => {
  const row = rowFrom(normalize({ ...raw, category: 'מסעדה' }));
  assert.equal(row[HEADERS.indexOf('ספק')], 'מסעדת הגליל בע"מ');
  assert.equal(row[HEADERS.indexOf('קטגוריה')], 'מסעדה');
});

test('rowFrom משאיר תא ריק כשהשדה לא נקרא', () => {
  const row = rowFrom(normalize({ ...raw, total: null, doc_number: null }));
  assert.equal(row[HEADERS.indexOf('סכום כולל')], '');
  assert.equal(row[HEADERS.indexOf('מספר חשבונית')], '');
});

test('colLetter ממיר מספר עמודה לאות', () => {
  assert.equal(colLetter(1), 'A');
  assert.equal(colLetter(7), 'G');
  assert.equal(colLetter(27), 'AA');
});

test('hebField נופל חזרה לשם המקורי כשאין תרגום', () => {
  assert.equal(hebField('doc_number'), 'מספר חשבונית');
  assert.equal(hebField('something_else'), 'something_else');
});

// ── ההודעה שחוזרת לקבוצה ────────────────────────────────────────────
test('money ו-heDate בפורמט ישראלי', () => {
  assert.equal(money(1234.5, 'ILS'), '1,234.50 ₪');
  assert.equal(money(20, 'USD'), '20.00 $');
  assert.equal(money(null), null);
  assert.equal(heDate('2026-08-04'), '4.8.2026');
  assert.equal(heDate(null), null);
});

test('receiptMessage מציג את שלושת השדות', () => {
  const msg = receiptMessage(normalize(raw), { row: 12, sheetUrl: 'https://sheet' });
  assert.match(msg, /444\.00 ₪/);
  assert.match(msg, /חשבונית 0038412/);
  assert.match(msg, /שורה 12/);
});

test('receiptMessage מפרט את חישוב הטיפ', () => {
  const msg = receiptMessage(normalize({ ...raw, tip_extra: 50 }), {});
  assert.match(msg, /494\.00 ₪/);
  assert.match(msg, /444\.00 ₪ \+ 50\.00 ₪ טיפ/);
});

test('receiptMessage אומר במפורש מה לא נקרא', () => {
  const msg = receiptMessage(normalize({ ...raw, total: null, doc_number: null }), {});
  assert.match(msg, /הסכום לא זוהה/);
  assert.match(msg, /מספר החשבונית לא זוהה/);
  assert.match(msg, /צריך להשלים ידנית/);
});

// ── התאמה מול הגיליון (זיהוי כפילות אמיתית) ─────────────────────────
test('normDoc מנקה גרשה מובילה ורווחים', () => {
  assert.equal(normDoc("'0038412"), '0038412');
  assert.equal(normDoc('  119069 '), '119069');
  assert.equal(normDoc(''), null);
  assert.equal(normDoc(null), null);
});

test('numOf קורא סכום כפי שהגיליון מציג אותו', () => {
  assert.equal(numOf('494.00 ₪'), 494);
  assert.equal(numOf('1,234.50 ₪'), 1234.5);
  assert.equal(numOf(''), null);
});

test('sameDate משווה תאריך ישראלי מול ISO', () => {
  assert.equal(sameDate('03/08/2026', '2026-08-03'), true);
  assert.equal(sameDate('3/8/2026', '2026-08-03'), true);     // בלי אפסים מובילים
  assert.equal(sameDate('03/08/2026', '2026-03-08'), false);  // לא מתבלבל בין יום לחודש
  assert.equal(sameDate('', '2026-08-03'), false);
});

test('הודעת כפילות מציינת את מספר השורה', () => {
  const msg = errorMessage('duplicate', 'קפה גרציאני, 60.00 ₪, 19.8.2026', 10);
  assert.match(msg, /כבר בטבלה/);
  assert.match(msg, /שורה 10/);
  assert.match(msg, /קפה גרציאני/);
});

test('rowFrom מייצר קישור להורדת הקבלה', () => {
  const row = rowFrom(normalize(raw), 'https://drive.google.com/uc?export=download&id=ABC');
  const cell = row[HEADERS.indexOf('קבלה')];
  assert.match(cell, /^=HYPERLINK\(/);
  assert.match(cell, /export=download&id=ABC/);
  assert.match(cell, /פתח/);
});

test('בלי קישור — התא נשאר ריק', () => {
  assert.equal(rowFrom(normalize(raw))[HEADERS.indexOf('קבלה')], '');
});

// ── שעת הקבלה ───────────────────────────────────────────────────────
test('clockTime מנרמל לפורמט 24 שעות', () => {
  assert.equal(clockTime('21:06'), '21:06');
  assert.equal(clockTime('9:05'), '09:05');        // אפס מוביל מתווסף
  assert.equal(clockTime('14:22:35'), '14:22');    // שניות נזרקות
  assert.equal(clockTime('שעה: 16:48'), '16:48');  // טקסט מסביב
  assert.equal(clockTime('25:00'), null);          // שעה שלא קיימת
  assert.equal(clockTime('12:71'), null);          // דקה שלא קיימת
  assert.equal(clockTime(''), null);
  assert.equal(clockTime(null), null);
});

test('rowFrom כותב את שעת הקבלה', () => {
  assert.equal(rowFrom(normalize({ ...raw, time: '21:06' }))[HEADERS.indexOf('שעה')], '21:06');
  assert.equal(rowFrom(normalize(raw))[HEADERS.indexOf('שעה')], '');
});

test('receiptMessage מציג את השעה לצד התאריך', () => {
  assert.match(receiptMessage(normalize({ ...raw, time: '21:06' }), {}), /🕒 21:06/);
});

// ── המאזן בהודעה ────────────────────────────────────────────────────
test('receiptMessage מציג את המאזן כשיש קבלות ממתינות', () => {
  const msg = receiptMessage(normalize(raw), {
    row: 9, balance: { pending: 1891.63, count: 9, done: 0, currency: 'ILS' },
  });
  assert.match(msg, /ממתין להזנה: 1,891\.63 ₪/);
  assert.match(msg, /9 קבלות בהמתנה/);
});

test('לשון יחיד כשיש קבלה אחת בלבד', () => {
  const msg = receiptMessage(normalize(raw), {
    row: 2, balance: { pending: 60, count: 1, done: 0, currency: 'ILS' },
  });
  assert.match(msg, /1 קבלה בהמתנה/);
});

test('בלי מאזן — ההודעה נשארת נקייה', () => {
  const msg = receiptMessage(normalize(raw), { row: 2 });
  assert.doesNotMatch(msg, /ממתין להזנה/);
});

test('אפס ממתינות — לא מציגים מאזן ריק', () => {
  const msg = receiptMessage(normalize(raw), {
    row: 2, balance: { pending: 0, count: 0, done: 500, currency: 'ILS' },
  });
  assert.doesNotMatch(msg, /ממתין להזנה/);
});

// ── מספר סועדים ─────────────────────────────────────────────────────
test('guestCount מקבל רק מספר שלם וסביר', () => {
  assert.equal(guestCount(3), 3);
  assert.equal(guestCount('4'), 4);
  assert.equal(guestCount('x3'), 3);
  assert.equal(guestCount(0), null);      // אפס סועדים לא קיים
  assert.equal(guestCount(-2), null);
  assert.equal(guestCount(120), null);    // לא סביר לקבלת מסעדה
  assert.equal(guestCount(null), null);
  assert.equal(guestCount(''), null);
});

test('normalize מעביר את מספר הסועדים', () => {
  assert.equal(normalize({ ...raw, guests: 3 }).guests, 3);
  assert.equal(normalize(raw).guests, null);
});

// ── שאלת המשך ───────────────────────────────────────────────────────
test('שאלות המשך לפי קטגוריה', () => {
  assert.deepEqual(followUpSteps('מסעדה'), ['customer', 'guestNames']);
  assert.deepEqual(followUpSteps('חניה'), ['customer', 'isAltCar']);
  assert.deepEqual(followUpSteps('דלק'), ['isAltCar']);
  assert.deepEqual(followUpSteps('אחר'), []);
});

test('כשזוהה מספר סועדים — השאלה מזכירה אותו', () => {
  assert.match(stepQuestion('guestNames', 'מסעדה', 3), /3 סועדים/);
  assert.match(stepQuestion('customer', 'חניה', null), /מי הלקוח/);
});

test('rowFrom כותב את מספר הסועדים', () => {
  const row = rowFrom(normalize({ ...raw, category: 'מסעדה', guests: 3 }));
  assert.equal(row[HEADERS.indexOf('סועדים')], 3);
  // לקוח ואורחים מתמלאים רק אחרי שעונים בוואטסאפ
  assert.equal(row[HEADERS.indexOf('לקוח')], '');
  assert.equal(row[HEADERS.indexOf('אורחים')], '');
});

test('לקוח ואורחים נכתבים כשהם מגיעים מהתשובות', () => {
  const row = rowFrom({ ...normalize(raw), customer: 'בינת', guestNames: 'אני, רמי' });
  assert.equal(row[HEADERS.indexOf('לקוח')], 'בינת');
  assert.equal(row[HEADERS.indexOf('אורחים')], 'אני, רמי');
});

// ── רכב חלופי ───────────────────────────────────────────────────────
test('parseYesNo מבין כן ולא', () => {
  assert.equal(parseYesNo('לא'), false);
  assert.equal(parseYesNo('no'), false);
  assert.equal(parseYesNo('כן'), true);
  assert.equal(parseYesNo('yes'), true);
  assert.equal(parseYesNo('כן 33140703'), true);
  assert.equal(parseYesNo('33140703'), true);      // מספר לבדו = כן
  assert.equal(parseYesNo('אולי'), null);          // לא ברור — נשאל שוב
  assert.equal(parseYesNo(''), null);
});

test('carNumber מחלץ 7 או 8 ספרות', () => {
  assert.equal(carNumber('כן 33140703'), '33140703');
  assert.equal(carNumber('המספר הוא 1234567'), '1234567');
  assert.equal(carNumber('33-140-703'), null);     // אין רצף של 7+
  assert.equal(carNumber('123'), null);            // קצר מדי
  assert.equal(carNumber('בלי מספר'), null);
});

test('rowFrom כותב מספר רכב חלופי', () => {
  const row = rowFrom({ ...normalize(raw), altCar: '33140703' });
  assert.equal(row[HEADERS.indexOf('רכב חלופי')], '33140703');
  assert.equal(rowFrom(normalize(raw))[HEADERS.indexOf('רכב חלופי')], '');
});

test('שאלת הרכב החלופי מציעה גם תשובה מקוצרת', () => {
  const q = stepQuestion('isAltCar', 'דלק', null);
  assert.match(q, /רכב חלופי/);
  assert.match(q, /33140703/);
});
