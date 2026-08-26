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

  // נראוּת לפי מידות ולא לפי offsetParent:
  // offsetParent הוא null לכל אלמנט עם position:fixed — כלומר לכל
  // חלון קופץ. זה מה ששבר את הזיהוי בגרסה הראשונה.
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };

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
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    if (setter) setter.call(el, value); else el.value = value;

    // שדות עם מסכה (התאריך) מחכים גם להקלדה, לא רק לשינוי ערך
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'End' }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'End' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // Tab סוגר את ההשלמה האוטומטית ומקבע את הערך
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab', keyCode: 9 }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  // ── בחירה מתפריט ──────────────────────────────────────────────────
  //
  //  "Expense Type" אינו select רגיל אלא רכיב עם תיבת חיפוש. הצבת
  //  טקסט לתוכו לא בוחרת כלום — הוא נשאר "-- None --", ואז השדות
  //  שתלויים בו לא נטענים. לכן שתי דרכים, לפי הסדר.
  async function selectOption(labelText, wanted, root) {
    const el = fieldByLabel(labelText, root);
    if (!el) return 'השדה לא נמצא';
    const want = norm(wanted);

    // 1. אם יש select אמיתי מתחת לרכיב — גם אם הוא מוסתר
    const group = el.closest('.form-group, .sc-form-field, .field-wrapper, div');
    const sel = el.tagName === 'SELECT' ? el : group?.querySelector('select');
    if (sel && sel.options?.length) {
      const opt = [...sel.options].find((o) => norm(o.text) === want)
        || [...sel.options].find((o) => norm(o.text).includes(want));
      if (opt) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(600);
        if (norm(sel.options[sel.selectedIndex]?.text).includes(want)) return null;
      }
    }

    // 2. ווידג'ט: פותחים, מקלידים בחיפוש, לוחצים על האפשרות
    el.click();
    group?.querySelector('.select2-arrow, .dropdown-toggle, [role=button]')?.click();
    await sleep(500);

    const search = [...document.querySelectorAll(
      'input[type=search], .select2-search input, input.select2-input, .dropdown-menu input',
    )].filter(visible).pop();
    if (search) { setValue(search, wanted); await sleep(600); }

    const option = await waitFor(() => [...document.querySelectorAll(
      '[role=option], li, .select2-result-label, .dropdown-item, .select2-results__option',
    )].filter(visible).find((o) => norm(o.textContent) === want), { timeout: 5000 });

    if (!option) return `לא נמצאה האפשרות "${wanted}" ברשימה`;
    option.click();
    await sleep(800);

    // מאמתים מול מה שמוצג עכשיו
    const now = fieldByLabel(labelText, root);
    const shown = norm(now?.value || now?.textContent || group?.textContent || '');
    return shown.includes(want) ? null : `נבחר משהו אחר: "${shown.slice(0, 40)}"`;
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
    'position:fixed', 'bottom:12px', 'left:12px', 'width:380px', 'max-height:45vh',
    'z-index:2147483647', 'background:#fff', 'border:2px solid #263238',
    'border-radius:10px', 'box-shadow:0 12px 40px rgba(0,0,0,.35)',
    'display:flex', 'flex-direction:column', 'font-family:system-ui,Arial,sans-serif',
    'direction:rtl',
  ].join(';'));

  const bar = document.createElement('div');
  bar.setAttribute('style', 'background:#263238;color:#fff;padding:10px 14px;display:flex;gap:8px;align-items:center;border-radius:7px 7px 0 0');
  bar.innerHTML = '<b style="flex:1">מילוי טופס הוצאות <span style="opacity:.6;font-weight:400">v3</span></b>';

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
    const title = `${item.vendor || 'ללא ספק'} · ${Math.round(item.amount)} ₪`;
    log(`<br><b>▶ ${title}</b>`);

    const addBtn = buttonByText('Add');
    if (!addBtn) { problems.push(`${title}: לא נמצא כפתור Add`); log('❌ אין כפתור Add', '#c62828'); break; }
    addBtn.click();

    const modalSel = '.modal-content, .modal-dialog, .modal, [role=dialog], [aria-modal=true]';
    const modal = await waitFor(() => [...document.querySelectorAll(modalSel)].filter(visible).pop());
    if (!modal) { problems.push(`${title}: החלון לא נפתח`); log('❌ החלון לא נפתח', '#c62828'); break; }
    await sleep(400);

    // סוג ההוצאה קודם — הוא זה שקובע אילו שדות בכלל יופיעו בחלון
    const typeErr = await selectOption('Expense Type', item.expenseType, modal);
    if (typeErr) {
      problems.push(`${title}: סוג ההוצאה — ${typeErr}`);
      log(`❌ סוג ההוצאה: ${typeErr}`, '#c62828');
      break;
    }
    log(`   סוג: ${item.expenseType}`, '#78909c');

    // ממתינים שהשדות התלויים ייטענו, ולא רק פרק זמן קבוע
    const dependent = item.category === 'דלק' ? 'Alternative Car Number'
      : item.category === 'חניה' ? 'Customer Name'
        : item.category === 'מסעדה' ? 'Guests Names' : null;
    if (dependent) {
      const ready = await waitFor(() => fieldByLabel(dependent, modal), { timeout: 6000 });
      if (!ready) {
        problems.push(`${title}: "${dependent}" לא הופיע אחרי בחירת הסוג`);
        log(`❌ "${dependent}" לא הופיע`, '#c62828');
        break;
      }
    }
    await sleep(300);

    // הטופס מקבל סכום שלם בלבד — מעגלים לשלם הקרוב
    const amount = String(Math.round(item.amount));

    const fill = [
      ['Expense Date Start', item.date],
      ['Invoice Number', item.invoice],
      ['Amount', amount],
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
      if (!el) { failedField = `${label} — השדה לא נמצא`; break; }

      setValue(el, value);
      await sleep(250);

      // שדות עם מסכה עשויים להציג את הערך אחרת ממה שהוקלד.
      // מספיק שהספרות זהות — לא דורשים התאמה תו-בתו.
      const digits = (s) => String(s).replace(/\D/g, '');
      const ok = norm(el.value) === norm(value) || digits(el.value) === digits(value);
      if (!ok) {
        failedField = `${label} — הוקלד "${value}" אבל בשדה יש "${el.value}"`;
        break;
      }
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

    const closed = await waitFor(() => ![...document.querySelectorAll(modalSel)].some(visible), { timeout: 8000 });
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
