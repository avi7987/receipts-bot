// =====================================================================
//  vision.js — קריאת הקבלה עצמה.
//
//  שולח את התמונה (או ה-PDF) ל-Gemini עם הוראות ממוקדות לקבלות
//  ישראליות, ומקבל בחזרה JSON נקי. מה שלא מופיע בקבלה — נשאר ריק
//  ומסומן כלא-ודאי. הבוט לא ממציא נתונים, בשום מצב.
// =====================================================================
import 'dotenv/config';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

export function visionAvailable() {
  return !!GEMINI_KEY;
}

const PROMPT = `You are reading a business expense receipt or invoice, most often an Israeli one written in Hebrew.
Extract the data exactly as printed. Return ONLY valid JSON, no markdown, in this exact shape:

{
  "is_receipt": true|false,
  "not_receipt_reason": "short Hebrew sentence, only when is_receipt is false, otherwise null",
  "date": "YYYY-MM-DD, or null",
  "total": number or null,
  "doc_number": "the document/invoice/receipt number as printed, or null",
  "tip_extra": number or null,
  "currency": "ILS" | "USD" | "EUR" | "GBP" | other ISO code,
  "vendor": "business name as printed, or null",
  "uncertain": ["names of fields above you could not read confidently"]
}

RULES — follow every one of them:
1. NEVER invent a value. If something is not printed, or you cannot read it, set it to null AND add the field name to "uncertain". A missing value is fine; a wrong value is not.
2. DATES ARE DAY-FIRST. Israeli receipts write 04/08/2026 meaning 4 August 2026 — never American month-first. A two-digit year like 26 means 2026. Output strictly YYYY-MM-DD.
3. NUMBERS: plain decimals with a dot, no currency symbol, no thousands separator. "1,234.50 ₪" becomes 1234.5.
4. "total" is the FINAL amount actually charged (סה"כ לתשלום / סך הכל), INCLUDING VAT and including any tip or service charge that is already printed on the document. If the receipt shows both a before-VAT and an after-VAT total, "total" is the after-VAT one. Never report a subtotal here.
5. "tip_extra" is ONLY for a tip that the person states in their note and that is NOT already part of "total" — typically a cash tip left on the table. If no such note exists, set it to null. Never guess a tip, and never move a printed tip here.
6. "doc_number" is the invoice/receipt number (חשבונית מס' / קבלה מס' / מספר מסמך). Keep leading zeros exactly as printed. It is NOT the credit-card approval number (מספר אישור), NOT the terminal number, and NOT the business's ח.פ.
7. ₪ / ש"ח / שקל / NIS all mean currency "ILS". If no currency is shown anywhere and the text is Hebrew, assume "ILS" and do NOT mark it uncertain.
8. "vendor" is the business that was PAID — usually the largest name at the top, near the ח.פ. It is not the customer, and not the credit card company. It is used only for the confirmation message, not for the table.
9. If the picture is not a receipt or invoice at all (a photo, a screenshot of a chat, a blurry unreadable page), set "is_receipt": false, explain shortly in Hebrew in "not_receipt_reason", and leave every other field null.
10. If the picture IS a receipt but is too blurry/cropped to read a specific field, still return the fields you can read, and list the rest in "uncertain".
11. Output nothing except the JSON object.`;

/**
 * קורא קבלה ומחזיר אובייקט מובנה, או זורק שגיאה.
 * @param {string} base64
 * @param {string} mimetype
 * @param {string|null} caption  טקסט שנשלח יחד עם התמונה — רמז, לא מקור אמת
 */
export async function readReceipt(base64, mimetype, caption = null) {
  if (!visionAvailable()) throw new Error('missing-gemini-key');

  const parts = [{ inlineData: { mimeType: mimetype, data: base64 } }];
  if (caption && caption.trim()) {
    parts.push({
      text: `The person sent this note along with the file: "${caption.trim()}".
If — and only if — the note states a tip that is not already printed on the receipt
(for example "טיפ 50", "השארתי 40 טיפ במזומן"), put that number in "tip_extra".
Otherwise ignore the note. It never overrides what is printed on the receipt.`,
    });
  }

  const raw = await callGemini(parts);
  const json = extractJson(raw);
  if (!json || typeof json !== 'object') {
    // מדפיסים את מה שבאמת חזר — בלי זה "bad-json" הוא מבוי סתום
    console.error('⚠️  התשובה מ-Gemini לא הייתה JSON תקין. 300 התווים הראשונים:');
    console.error(`   ${String(raw).slice(0, 300)}`);
    throw new Error('bad-json');
  }

  return normalize(json);
}

// ── הקריאה ל-Gemini ─────────────────────────────────────────────────
async function callGemini(parts) {
  let lastErr;
  // ניסיון שני — כשלים רגעיים ב-API הם דבר שקורה
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
        signal: AbortSignal.timeout(90000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: PROMPT }] },
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            // המודלים החדשים "חושבים" לפני שהם עונים, והחשיבה נחשבת
            // בתקציב הפלט. עם 2048 התשובה עצמה יצאה ריקה לפעמים —
            // זה היה ה-bad-json. תקציב רחב פותר את זה.
            // (לכבות חשיבה לגמרי אי אפשר: thinkingBudget:0 מוחזר כשגיאה 400)
            maxOutputTokens: 8192,
          },
        }),
      });
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);

      const data = await res.json();
      const cand = data?.candidates?.[0];
      // חלקי "מחשבה" אינם התשובה — מסננים אותם החוצה
      const text = (cand?.content?.parts || [])
        .filter((p) => !p.thought)
        .map((p) => p.text)
        .filter(Boolean)
        .join('');

      if (!text) {
        const why = cand?.finishReason || data?.promptFeedback?.blockReason || 'לא ידוע';
        throw new Error(`תשובה ריקה מ-Gemini (סיבה: ${why})`);
      }
      return text;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

// מודלים לפעמים עוטפים את ה-JSON ב-```json — מחלצים את האובייקט הראשון
export function extractJson(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch { /* ממשיכים לניסיון הבא */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* ויתרנו */ }
  }
  return null;
}

// ── ניקוי וסידור מה שחזר ────────────────────────────────────────────
export function normalize(j) {
  const uncertain = new Set(Array.isArray(j.uncertain) ? j.uncertain.filter((x) => typeof x === 'string') : []);

  const out = {
    is_receipt: j.is_receipt !== false,
    not_receipt_reason: str(j.not_receipt_reason),
    date: isoDate(j.date),
    total: num(j.total),
    doc_number: str(j.doc_number),
    tip_extra: num(j.tip_extra),
    currency: (str(j.currency) || 'ILS').toUpperCase().slice(0, 3),
    vendor: str(j.vendor),
    total_with_tip: null,
    uncertain: [],
  };

  // טיפ אפס או שלילי הוא רעש — מתעלמים
  if (out.tip_extra !== null && out.tip_extra <= 0) out.tip_extra = null;

  // הסכום שנכנס לטבלה: מה שנגבה בפועל, ועוד טיפ שנמסר במזומן אם צוין
  if (out.total !== null) {
    out.total_with_tip = round2(out.total + (out.tip_extra || 0));
  }

  // שדה שחזר ריק הוא לא ודאי, גם אם המודל שכח לציין את זה
  for (const f of ['date', 'total', 'doc_number']) {
    if (out[f] === null) uncertain.add(f);
  }
  // תאריך עתידי או עתיק מדי — כמעט תמיד קריאה שגויה של הפורמט
  if (out.date && !dateLooksSane(out.date)) uncertain.add('date');

  out.uncertain = [...uncertain];
  return out;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── עזרי המרה ───────────────────────────────────────────────────────
function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === 'null' || s === 'undefined' || s === '-') return null;
  return s;
}

export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // "1,234.50 ₪" → 1234.5
  const s = String(v).replace(/[^\d.,\-]/g, '').replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export function isoDate(v) {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(`${y}-${mo}-${d}T12:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  // מוודאים שהתאריך באמת קיים (31.02 יתגלגל לחודש הבא)
  if (dt.getUTCMonth() + 1 !== Number(mo) || dt.getUTCDate() !== Number(d)) return null;
  return `${y}-${mo}-${d}`;
}

export function dateLooksSane(iso) {
  const t = new Date(`${iso}T12:00:00Z`).getTime();
  if (Number.isNaN(t)) return false;
  const now = Date.now();
  const DAY = 86400e3;
  return t < now + 2 * DAY && t > now - 730 * DAY;   // לא בעתיד, ולא מלפני שנתיים
}
