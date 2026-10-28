// =====================================================================
//  inspect-attach.js — מדווח מה באמת קורה ברכיב הצרופות.
//
//  מריצים כשחלון "Add Row" פתוח. הכלי לא ממלא כלום ולא שולח כלום
//  החוצה — הוא רק מסתכל, מנסה להציב קובץ קטן, ומדפיס מה קרה.
//
//  נכתב כי אי אפשר לתקן רכיב שלא רואים: שלושה תיקונים נבנו על ניחוש
//  מה הוא מאזין לו, וכל אחד מהם נכשל אחרת.
// =====================================================================
(async function () {
  const lines = [];
  const say = (s) => { lines.push(s); };

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const desc = (el) => {
    if (!el) return '—';
    const id = el.id ? `#${el.id}` : '';
    const cls = (el.className && typeof el.className === 'string') ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  const modalSel = '.modal-content, .modal-dialog, .modal, [role=dialog], [aria-modal=true]';
  const modal = [...document.querySelectorAll(modalSel)].filter(visible).pop();
  say(`חלון פתוח: ${modal ? desc(modal) : 'לא נמצא — פתח Add Row ונסה שוב'}`);
  const root = modal || document;

  // ── שדות הקובץ ──
  const inputs = [...root.querySelectorAll('input[type=file]')];
  say(`שדות קובץ בחלון: ${inputs.length}`);
  inputs.forEach((i, n) => {
    say(`  ${n + 1}. ${desc(i)} | נראה: ${visible(i)} | accept="${i.accept || ''}" | multiple=${i.multiple} | הורה: ${desc(i.parentElement)}`);
  });

  // ── כפתורים וכותרות סביב הצרופות ──
  const texts = ['Upload', 'Attach', 'Attachments', 'צרופ', 'העל'];
  const hits = [...root.querySelectorAll('button, a, label, div, span')]
    .filter((el) => visible(el) && texts.some((t) => (el.textContent || '').trim().startsWith(t)) && (el.textContent || '').length < 40)
    .slice(0, 6);
  say(`רכיבים עם טקסט של צרופות: ${hits.length}`);
  hits.forEach((el) => say(`  · "${(el.textContent || '').trim().slice(0, 25)}" → ${desc(el)} | הורה: ${desc(el.parentElement)}`));

  // ── אנגולר ──
  say(`AngularJS בעמוד: ${!!window.angular}`);
  if (window.angular && inputs[0]) {
    try {
      const sc = window.angular.element(inputs[0]).scope?.();
      if (sc) {
        const fns = Object.keys(sc).filter((k) => typeof sc[k] === 'function' && !k.startsWith('$')).slice(0, 14);
        say(`  פונקציות בסקופ של שדה הקובץ: ${fns.join(', ') || '(אין)'}`);
      } else {
        say('  אין סקופ על שדה הקובץ');
      }
      const asc = hits[0] && window.angular.element(hits[0]).scope?.();
      if (asc) {
        const fns = Object.keys(asc).filter((k) => typeof asc[k] === 'function' && !k.startsWith('$')).slice(0, 14);
        say(`  פונקציות בסקופ של רכיב ההעלאה: ${fns.join(', ') || '(אין)'}`);
      }
    } catch (e) { say(`  קריאת הסקופ נכשלה: ${e.message}`); }
  }

  // ── האזנה לרשת, לפני כל פעולה ──
  const calls = [];
  const origFetch = window.fetch;
  const origOpen = XMLHttpRequest.prototype.open;
  window.fetch = function (...a) { calls.push(`fetch ${String(a[0]).slice(0, 80)}`); return origFetch.apply(this, a); };
  XMLHttpRequest.prototype.open = function (m, u, ...a) { calls.push(`xhr ${m} ${String(u).slice(0, 80)}`); return origOpen.call(this, m, u, ...a); };

  //  מבצע בדיוק את הרצף של המילוי: טריגר אחד, המתנה להעלאה, ואז
  //  עדכון שדה הטופס — כדי לבדוק אם זה מה שחסר, בלי להריץ מילוי שלם.
  if (inputs.length) {
    const input = inputs[0];
    const before = (root.innerText || '').length;
    const file = new File([new Blob(['x'.repeat(1024)], { type: 'image/jpeg' })], 'בדיקה.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer();
    dt.items.add(file);
    try {
      input.files = dt.files;
      say(`הצבת קובץ בשדה 1: ${input.files.length ? 'הצליחה' : 'נדחתה'}`);
    } catch (e) { say(`הצבת קובץ נכשלה: ${e.message}`); }

    const was = calls.length;
    input.dispatchEvent(new Event('change', { bubbles: true }));     // טריגר אחד בלבד
    for (let i = 0; i < 15 && calls.length === was; i++) await new Promise((r) => setTimeout(r, 200));
    say(`העלאה אחרי אירוע רגיל: ${calls.length > was ? 'יצאה' : 'לא יצאה'}`);

    await new Promise((r) => setTimeout(r, 2500));

    const sc = window.angular ? window.angular.element(input).scope?.() : null;
    try {
      const has = typeof sc?.updateAttachmentBackendValues === 'function';
      say(`updateAttachmentBackendValues קיימת: ${has}`);
      if (has) { sc.updateAttachmentBackendValues(); sc.$applyAsync?.(); }
    } catch (e) { say(`עדכון שדה הטופס נכשל: ${e.message}`); }

    await new Promise((r) => setTimeout(r, 2500));

    const after = (root.innerText || '').length;
    say(`אורך הטקסט בחלון: ${before} → ${after} ${after !== before ? '(השתנה)' : '(לא השתנה)'}`);
    say(`שם הקובץ מופיע בחלון: ${(root.innerText || '').includes('בדיקה')}`);

    //  הבדיקה האמיתית: מה הטופס חושב על שדה הצרופה
    try {
      const gf = sc?.gForm;
      if (gf?.getValue) {
        for (const f of ['attachment', 'attachments', 'u_attachment']) {
          const v = gf.getValue(f);
          if (v !== undefined && v !== null) say(`gForm.getValue("${f}") = ${String(v).slice(0, 60) || '(ריק)'}`);
        }
      } else { say('אין gForm בסקופ'); }
      if (typeof sc?.validateAttachment === 'function') {
        say(`validateAttachment() = ${JSON.stringify(sc.validateAttachment())}`);
      }
    } catch (e) { say(`בדיקת שדה הצרופה נכשלה: ${e.message}`); }
  }

  window.fetch = origFetch;
  XMLHttpRequest.prototype.open = origOpen;
  say(`קריאות רשת מאז ההצבה: ${calls.length}`);
  calls.slice(0, 6).forEach((c) => say(`  · ${c}`));

  // ── תצוגה ──
  const box = document.createElement('div');
  box.setAttribute('style', [
    'position:fixed', 'inset:auto 12px 12px auto', 'width:min(560px,92vw)', 'max-height:70vh',
    'overflow:auto', 'z-index:2147483647', 'background:#fff', 'border:1px solid #263238',
    'border-radius:8px', 'padding:14px', 'font:13px/1.6 Consolas,monospace', 'direction:ltr',
    'text-align:left', 'box-shadow:0 8px 28px rgba(0,0,0,.3)', 'white-space:pre-wrap',
  ].join(';'));
  const report = lines.join('\n');
  box.textContent = report;

  const bar = document.createElement('div');
  bar.setAttribute('style', 'display:flex;gap:8px;margin-bottom:10px;direction:rtl');
  const copy = document.createElement('button');
  copy.textContent = 'העתק דוח';
  copy.setAttribute('style', 'font:600 13px sans-serif;background:#263238;color:#fff;border:0;border-radius:5px;padding:6px 14px;cursor:pointer');
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(report); copy.textContent = 'הועתק'; }
    catch { copy.textContent = 'סמן והעתק ידנית'; }
  };
  const close = document.createElement('button');
  close.textContent = 'סגור';
  close.setAttribute('style', 'font:600 13px sans-serif;background:#eee;border:0;border-radius:5px;padding:6px 14px;cursor:pointer');
  close.onclick = () => box.remove();
  bar.append(copy, close);
  box.prepend(bar);
  document.body.appendChild(box);
})();
