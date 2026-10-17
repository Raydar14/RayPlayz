// Public intake form — serializes the fields and POSTs to /api/intake.
// Partial submissions are fine; only display_name is required. Progress
// counter rewards filling things in, but the Send button is always live.

(() => {
  const form   = document.getElementById('intakeForm');
  const submit = document.getElementById('submitBtn');
  const result = document.getElementById('result');
  const pct    = document.getElementById('progressPct');

  // These keys mirror the server's completeness check so the user-facing
  // percent matches what the DB stores.
  const PROGRESS_KEYS = [
    'contact_handle', 'age', 'height_cm', 'speaks_spanish', 'speaks_english',
    'has_kids', 'location', 'will_travel', 'availability', 'has_car',
    'can_drive', 'has_pets', 'likes_cats', 'job', 'can_cook',
    'skills', 'hobbies', 'long_term_named', 'real_failure', 'handle_disagree',
  ];

  const BOOL_KEYS = new Set([
    'speaks_spanish', 'speaks_english', 'has_kids', 'will_travel',
    'has_car', 'is_4x4', 'can_drive', 'has_pets', 'likes_cats', 'can_cook',
  ]);
  const INT_KEYS = new Set(['age', 'height_cm']);

  function readForm() {
    const fd = new FormData(form);
    const out = {};
    for (const [k, v] of fd.entries()) {
      const s = typeof v === 'string' ? v.trim() : v;
      if (s === '' || s == null) continue;
      if (BOOL_KEYS.has(k)) out[k] = (s === '1' || s === 'yes') ? 1 : 0;
      else if (INT_KEYS.has(k)) {
        const n = Number(s);
        if (Number.isFinite(n)) out[k] = n;
      }
      else out[k] = s;
    }
    return out;
  }

  function recomputeProgress() {
    const data = readForm();
    let filled = 0;
    for (const k of PROGRESS_KEYS) {
      if (data[k] !== undefined && data[k] !== '' && data[k] !== null) filled++;
    }
    const p = Math.round((filled / PROGRESS_KEYS.length) * 100);
    pct.textContent = p + '%';
  }

  form.addEventListener('input', recomputeProgress);
  form.addEventListener('change', recomputeProgress);
  recomputeProgress();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    result.hidden = true;
    result.className = 'result';

    const data = readForm();
    if (!data.display_name) {
      result.hidden = false;
      result.classList.add('err');
      result.textContent = 'Please at least put your name in before sending.';
      form.querySelector('[name=display_name]').focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Sending…';

    try {
      const resp = await fetch('/api/intake', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(payload?.error || 'send_failed');
      }
      result.hidden = false;
      result.classList.add('ok');
      const p = payload.completeness_pct ?? 0;
      result.innerHTML =
        'Sent. ' + p + '% complete — she\'ll see what you wrote.' +
        '<br><span style="color:var(--mute); font-size:.85em">You can close this tab.</span>';
      submit.textContent = 'Sent';
      // Prevent accidental double-submit.
      submit.disabled = true;
    } catch (err) {
      result.hidden = false;
      result.classList.add('err');
      result.textContent = 'Couldn\'t send: ' + (err?.message || 'unknown error') + '. Try again.';
      submit.disabled = false;
      submit.textContent = 'Send to Ray';
    }
  });
})();
