// =====================================================================
//  fill-form.js — ממלא את טופס החזר ההוצאות מהטבלה.
//
//  רץ בדפדפן שלך, בהתחברות שלך, רק כשאתה לוחץ. שום דבר לא רץ לבד.
//
//  מה הוא עושה: מושך את הקבלות שעדיין לא הוזנו, ולכל אחת פותח
//  "Add Row", ממלא את השדות, מצרף את התמונה, ולוחץ Add.
//
//  מה הוא לא עושה: לא לוחץ Submit. ההגשה היא הצהרה שלך, לא שלו.
//
//  אם שדה חובה לא נתפס — הוא עוצר ומדווח, במקום להוסיף שורה חסרה.
// =====================================================================
(async function () {
  const API = '__API__';          // מוחלף בבנייה
  const KEY = '__KEY__';
  const ALT_CAR = '11111111';     // מספר רכב חלופי — זמני, לעדכון בטיוטה
  const TBD = 'TBD';

  // ── עזרי המתנה ────────────────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, { timeout = 12000, every = 150 } = {}) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const v = fn();
      if (v) return v;
      await sleep(every);
    }
    return null;
  }

  const visible = (el) => el && el.offsetParent !== null;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\*/g, '').trim();

  // ── איתור שדה לפי התווית שרואים ────────────────────────────────────
  //
  //  לפי תווית ולא לפי מזהה: ServiceNow מייצרת מזהים דינמיים, אבל
  //  התוויות הן מה שאתה רואה ומה שנשאר יציב.
  function fieldByLabel(text, root = document) {
    const want = norm(text);
    const labels = [...root.querySelectorAll('label')].filter(visible);

    for (const lb of labels) {
      if (norm(lb.textContent) !== want) continue;

      if (lb.htmlFor) {
        const byFor = root.querySelector(`#${CSS.escape(lb.htmlFor)}`);
        if (visible(byFor)) return byFor;
      }
      const box = lb.closest('.form-group, .sc-form-field, .field-wrapper, div');
      const input = box && [...box.querySelectorAll('input, select, textarea')].find(visible);
      if (input) return input;
    }
    return null;
  }

  // ── הצבת ערך בדרך ש-Angular מזהה ──────────────────────────────────
  //
  //  הצבה ישירה ל-value לא מפעילה את המאזינים של המסגרת, ולכן
  //  משתמשים ב-setter המקורי ואז משדרים את האירועים בעצמנו.
  function setValue(el, value) {
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    el.focus();
    if (setter) setter.call(el, value); else el.value = value;
    for (const type of ['input', 'change', 'blur']) {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    }
    return true;
  }

  function setSelect(el, label) {
    if (!el) return false;
    if (el.tagName === 'SELECT') {
      const want = norm(label);
      const opt = [...el.options].find((o) => norm(o.text) === want)
        || [...el.options].find((o) => norm(o.text).includes(want));
      if (!opt) return false;
      el.focus();
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return setValue(el, label);
  }

  // ── צירוף הקובץ ────────────────────────────────────────────────────
  async function attach(url, name) {
    const input = [...document.querySelectorAll('input[type=file]')].pop();
    if (!input) return 'לא נמצא שדה קובץ';

    let blob;
    try {
      const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!r.ok) return `הורדת הקובץ נכשלה (${r.status})`;
      blob = await r.blob();
    } catch (e) {
      return `הורדת הקובץ נכשלה: ${e.message}`;
    }

    const file = new File([blob], name, { type: blob.type || 'image/jpeg' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // חלק מהרכיבים מקשיבים ל-drop ולא ל-change
    input.dispatchEvent(new CustomEvent('drop', { bubbles: true, detail: dt }));
    return null;
  }

  // ── כפתורים ────────────────────────────────────────────────────────
  const buttonByText = (text, root = document) => [...root.querySelectorAll('button, a.btn, input[type=button]')]
    .filter(visible)
    .find((b) => norm(b.textContent || b.value) === norm(text));

  // ── ממשק ───────────────────────────────────────────────────────────
  document.getElementById('__rb_fill')?.remove();
  const box = document.createElement('div');
  box.id = '__rb_fill';
  box.setAttribute('style', [
    'position:fixed', 'top:12px', 'left:12px', 'width:420px', 'max-height:85vh',
    'z-index:2147483647', 'background:#fff', 'border:2px solid #263238',
    'border-radius:10px', 'box-shadow:0 12px 40px rgba(0,0,0,.35)',
    'display:flex', 'flex-direction:column', 'font-family:system-ui,Arial,sans-serif',
    'direction:rtl',
  ].join(';'));

  const bar = document.createElement('div');
  bar.setAttribute('style', 'background:#263238;color:#fff;padding:10px 14px;display:flex;gap:8px;align-items:center;border-radius:7px 7px 0 0');
  bar.innerHTML = '<b style="flex:1">מילוי טופס הוצאות</b>';

  const stopBtn = document.createElement('button');
  stopBtn.textContent = 'עצור';
  stopBtn.setAttribute('style', 'padding:5px 12px;border:0;border-radius:5px;background:#c62828;color:#fff;cursor:pointer');
  let stopped = false;
  stopBtn.onclick = () => { stopped = true; log('⏹️ נעצר לבקשתך'); };

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('style', 'padding:5px 10px;border:0;border-radius:5px;background:#78909c;color:#fff;cursor:pointer');
  closeBtn.onclick = () => box.remove();

  bar.append(stopBtn, closeBtn);

  const body = document.createElement('div');
  body.setAttribute('style', 'padding:10px 14px;overflow:auto;font-size:13px;line-height:1.7');

  box.append(bar, body);
  document.body.appendChild(box);

  function log(html, color) {
    const p = document.createElement('div');
    p.innerHTML = html;
    if (color) p.style.color = color;
    body.appendChild(p);
    body.scrollTop = body.scrollHeight;
  }

  // ── משיכת הקבלות ──────────────────────────────────────────────────
  log('⏳ מושך את הקבלות הממתינות...');
  let pending;
  try {
    const r = await fetch(`${API}/pending?k=${KEY}`, { mode: 'cors', credentials: 'omit' });
    if (!r.ok) throw new Error(`שרת החזיר ${r.status}`);
    pending = (await r.json()).rows || [];
  } catch (e) {
    log(`❌ לא הצלחתי למשוך: ${e.message}`, '#c62828');
    log('בדוק שהשרת חי ושהמפתח נכון.', '#78909c');
    return;
  }

  const ready = pending.filter((p) => p.expenseType);
  const skipped = pending.filter((p) => !p.expenseType);

  log(`📄 ${pending.length} קבלות ממתינות`);
  if (skipped.length) {
    log(`⚠️ ${skipped.length} מדולגות — אין להן סוג הוצאה מתאים: ${skipped.map((s) => s.category || '?').join(', ')}`, '#ef6c00');
  }
  if (!ready.length) { log('אין מה למלא.', '#78909c'); return; }

  log(`<hr>מתחיל למלא ${ready.length} שורות. אל תיגע בעמוד.`);

  // ── הלולאה ────────────────────────────────────────────────────────
  let done = 0;
  const problems = [];

  for (const item of ready) {
    if (stopped) break;
    const title = `${item.vendor || 'ללא ספק'} · ${item.amount} ₪`;
    log(`<br><b>▶ ${title}</b>`);

    const addBtn = buttonByText('Add');
    if (!addBtn) { problems.push(`${title}: לא נמצא כפתור Add`); log('❌ אין כפתור Add', '#c62828'); break; }
    addBtn.click();

    const modal = await waitFor(() => [...document.querySelectorAll('.modal, [role=dialog]')].find(visible));
    if (!modal) { problems.push(`${title}: החלון לא נפתח`); log('❌ החלון לא נפתח', '#c62828'); break; }
    await sleep(400);

    // סוג ההוצאה קודם — הוא זה שקובע אילו שדות יופיעו
    const typeEl = fieldByLabel('Expense Type', modal);
    if (!setSelect(typeEl, item.expenseType)) {
      problems.push(`${title}: לא הצלחתי לבחור "${item.expenseType}"`);
      log(`❌ סוג ההוצאה לא נבחר`, '#c62828');
      break;
    }
    await sleep(700);        // השדות התלויים נטענים אחרי הבחירה

    // השדות המשותפים
    const fill = [
      ['Expense Date Start', item.date],
      ['Invoice Number', item.invoice],
      ['Amount', String(item.amount)],
    ];
    // לפי סוג ההוצאה
    if (item.category === 'דלק') fill.push(['Alternative Car Number', ALT_CAR]);
    if (item.category === 'חניה') fill.push(['Customer Name', item.customer || TBD]);
    if (item.category === 'מסעדה') {
      fill.push(['Customer Name', item.customer || TBD]);
      fill.push(['Number of guests', String(item.guests || 1)]);
      fill.push(['Guests Names', item.guestNames || TBD]);
    }

    let failedField = null;
    for (const [label, value] of fill) {
      const el = fieldByLabel(label, modal);
      if (!el) { failedField = `${label} — לא נמצא`; break; }
      setValue(el, value);
      await sleep(120);
      if (norm(el.value) !== norm(value)) { failedField = `${label} — הערך לא נתפס`; break; }
    }
    if (failedField) {
      problems.push(`${title}: ${failedField}`);
      log(`❌ ${failedField}`, '#c62828');
      break;
    }

    // הצרופה
    if (!item.file) {
      problems.push(`${title}: אין קובץ קבלה`);
      log('❌ אין קובץ מצורף לשורה הזו', '#c62828');
      break;
    }
    const attachErr = await attach(item.file, `${item.vendor || 'receipt'}_${item.amount}.jpg`);
    if (attachErr) {
      problems.push(`${title}: ${attachErr}`);
      log(`❌ ${attachErr}`, '#c62828');
      break;
    }
    await sleep(1500);       // ההעלאה צריכה להסתיים לפני Add

    const confirm = buttonByText('Add', modal);
    if (!confirm) { problems.push(`${title}: אין כפתור Add בחלון`); log('❌ אין Add בחלון', '#c62828'); break; }
    confirm.click();

    const closed = await waitFor(() => ![...document.querySelectorAll('.modal, [role=dialog]')].some(visible), { timeout: 8000 });
    if (!closed) {
      problems.push(`${title}: החלון לא נסגר — כנראה שדה חובה חסר`);
      log('❌ החלון לא נסגר. בדוק מה חסר.', '#c62828');
      break;
    }

    done++;
    log(`✅ נוסף (${done}/${ready.length})`, '#2e7d32');
    await sleep(600);
  }

  // ── סיכום ─────────────────────────────────────────────────────────
  log('<hr>');
  log(`<b>סיכום: ${done} שורות נוספו מתוך ${ready.length}</b>`);
  if (problems.length) {
    log('<b>מה נעצר:</b>', '#c62828');
    problems.forEach((p) => log(`• ${p}`, '#c62828'));
  }
  if (done) {
    log('<br>עכשיו עבור על השורות, השלם מה שחסר, ולחץ <b>Save as Draft</b>.', '#263238');
    log('שים לב: "מספר רכב חלופי" מולא ב-11111111 — עדכן אותו.', '#ef6c00');
  }
})();
