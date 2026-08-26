// =====================================================================
//  inspect-form.js — סימנייה שמציגה את מבנה הטופס ב-ServiceNow.
//
//  מה היא עושה: עוברת על השדות הנראים בעמוד, אוספת שם/תווית/סוג,
//  ומציגה אותם בחלון על גבי העמוד כדי שאפשר יהיה להעתיק.
//
//  מה היא לא עושה: לא שולחת כלום לשום מקום, לא נוגעת ב-cookies או
//  בסיסמאות, ולא משנה שום שדה. קריאה בלבד, והכל נשאר על המסך.
//
//  התקנה: ראה tools/README.md
// =====================================================================
(function () {
  // ── איסוף השדות ───────────────────────────────────────────────────
  const nodes = [...document.querySelectorAll('input, select, textarea')]
    .filter((e) => e.offsetParent !== null)                  // רק מה שבאמת מוצג
    .filter((e) => !['hidden', 'password'].includes(e.type)); // אף פעם לא שדות סיסמה

  const labelOf = (e) => {
    const byFor = e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
    const txt = byFor?.innerText
      || e.labels?.[0]?.innerText
      || e.getAttribute('aria-label')
      || e.closest('.form-group, .sc-form-field, fieldset')?.querySelector('label')?.innerText
      || e.placeholder
      || '';
    return txt.replace(/\s+/g, ' ').trim().slice(0, 70);
  };

  const fields = nodes.map((e, i) => ({
    '#': i + 1,
    label: labelOf(e),
    tag: e.tagName.toLowerCase(),
    type: e.type || '',
    name: e.name || '',
    id: e.id || '',
    required: !!(e.required || e.getAttribute('aria-required') === 'true'),
    options: e.tagName === 'SELECT'
      ? [...e.options].map((o) => o.text.trim()).filter(Boolean).slice(0, 12)
      : undefined,
  }));

  // ── תצוגה ─────────────────────────────────────────────────────────
  document.getElementById('__rb_inspect')?.remove();

  const box = document.createElement('div');
  box.id = '__rb_inspect';
  box.setAttribute('style', [
    'position:fixed', 'inset:5% 5% 5% 5%', 'z-index:2147483647',
    'background:#fff', 'border:2px solid #263238', 'border-radius:10px',
    'box-shadow:0 12px 40px rgba(0,0,0,.35)', 'display:flex',
    'flex-direction:column', 'font-family:system-ui,Arial,sans-serif',
  ].join(';'));

  const bar = document.createElement('div');
  bar.setAttribute('style', 'background:#263238;color:#fff;padding:10px 14px;display:flex;gap:10px;align-items:center;border-radius:7px 7px 0 0');
  bar.innerHTML = `<b style="flex:1">מבנה הטופס — ${fields.length} שדות</b>`;

  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'העתק הכל';
  copyBtn.setAttribute('style', 'padding:6px 14px;border:0;border-radius:5px;background:#4caf50;color:#fff;font-size:14px;cursor:pointer');

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'סגור';
  closeBtn.setAttribute('style', 'padding:6px 14px;border:0;border-radius:5px;background:#78909c;color:#fff;font-size:14px;cursor:pointer');
  closeBtn.onclick = () => box.remove();

  bar.append(copyBtn, closeBtn);

  const area = document.createElement('textarea');
  area.value = JSON.stringify(fields, null, 1);
  area.setAttribute('style', 'flex:1;width:100%;border:0;padding:12px;font-family:Consolas,monospace;font-size:12px;direction:ltr;resize:none;outline:none');
  area.readOnly = true;

  copyBtn.onclick = () => {
    area.select();
    document.execCommand('copy');
    copyBtn.textContent = '✓ הועתק';
    setTimeout(() => { copyBtn.textContent = 'העתק הכל'; }, 1500);
  };

  box.append(bar, area);
  document.body.appendChild(box);
  area.focus();
})();
