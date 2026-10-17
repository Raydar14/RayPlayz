// Public intake form — serializes the fields and POSTs to /api/intake.
// Partial submissions are fine; only display_name is required. Progress
// counter rewards filling things in, but the Send button is always live.

(() => {
  const form   = document.getElementById('intakeForm');
  const submit = document.getElementById('submitBtn');
  const result = document.getElementById('result');
  const pct    = document.getElementById('progressPct');

  // ---------- photo slots ----------
  // Each slot is a <label> wrapping a hidden <input type=file>. On change
  // we shrink the picked image to a reasonable max dimension and encode it
  // as a JPEG data URL — browser-side, so the original file never leaves
  // the device. The resulting data URL is stashed on the slot's dataset
  // and picked up at submit time.
  const PHOTO_MAX_EDGE = 1200;
  const PHOTO_QUALITY  = 0.80;
  const slots = Array.from(document.querySelectorAll('.photo-slot'));

  function resizeToDataURL(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) return reject(new Error('empty image'));
        const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(w, h));
        const dw = Math.round(w * scale);
        const dh = Math.round(h * scale);
        const canvas = document.createElement('canvas');
        canvas.width = dw;
        canvas.height = dh;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, dw, dh);
        canvas.toBlob(
          (blob) => {
            if (!blob) return reject(new Error('encode failed'));
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('read failed'));
            reader.readAsDataURL(blob);
          },
          'image/jpeg',
          PHOTO_QUALITY,
        );
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  function clearSlot(slot) {
    slot.classList.remove('filled');
    delete slot.dataset.image;
    const preview = slot.querySelector('.photo-preview');
    preview.style.backgroundImage = '';
    slot.querySelector('.photo-input').value = '';
  }

  for (const slot of slots) {
    const input   = slot.querySelector('.photo-input');
    const preview = slot.querySelector('.photo-preview');
    const remove  = slot.querySelector('.photo-remove');

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      // Show a busy veil so the suitor knows big phone photos take a sec.
      const busy = document.createElement('div');
      busy.className = 'photo-busy';
      busy.textContent = 'Shrinking…';
      slot.appendChild(busy);
      try {
        const dataURL = await resizeToDataURL(file);
        slot.dataset.image = dataURL;
        preview.style.backgroundImage = `url('${dataURL}')`;
        slot.classList.add('filled');
      } catch (err) {
        alert('Couldn\'t use that image: ' + (err?.message || 'unknown error'));
        input.value = '';
      } finally {
        busy.remove();
      }
    });

    remove.addEventListener('click', (e) => {
      // The remove button lives inside the <label>, so a click would also
      // trigger a new file picker. Swallow the propagation.
      e.preventDefault();
      e.stopPropagation();
      clearSlot(slot);
    });
  }

  function collectPhotos() {
    const photos = [];
    for (const slot of slots) {
      if (slot.dataset.image) photos.push(slot.dataset.image);
    }
    return photos;
  }

  // These keys mirror the server's completeness check so the user-facing
  // percent matches what the DB stores.
  const PROGRESS_KEYS = [
    'contact_handle', 'age', 'height_cm', 'speaks_spanish', 'speaks_english',
    'has_kids', 'location', 'will_travel', 'availability', 'has_car',
    'can_drive', 'has_pets', 'likes_cats', 'job', 'can_cook',
    'skills', 'hobbies', 'last_relationship_when', 'longest_relationship_length',
    'looking_for', 'brings_to_table', 'long_term_named', 'real_failure',
    'handle_disagree',
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
    const photos = collectPhotos();
    if (photos.length) data.photos = photos;
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
