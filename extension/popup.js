// Popup logic. Loads config, detects source from current tab, parses the
// pasted transcript into messages, posts to /api/ingest.

const $ = (s) => document.querySelector(s);

const SOURCE_HOSTS = [
  { host: 'instagram.com',    source: 'ig'       },
  { host: 'tinder.com',       source: 'tinder'   },
  { host: 'bumble.com',       source: 'bumble'   },
  { host: 'fetlife.com',      source: 'fetlife'  },
  { host: 'tiktok.com',       source: 'tiktok'   },
  { host: 'x.com',            source: 'x'        },
  { host: 'twitter.com',      source: 'x'        },
  { host: 'web.whatsapp.com', source: 'whatsapp' },
];

function setStrip(text, cls) {
  const s = $('#statusStrip');
  s.textContent = text;
  s.className = 'strip' + (cls ? ' ' + cls : '');
}
function setPreview(text, cls) {
  const p = $('#preview');
  p.textContent = text;
  p.className = 'preview' + (cls ? ' ' + cls : '');
}
function setResult(html, cls) {
  const r = $('#result');
  r.innerHTML = html;
  r.className = 'result' + (cls ? ' ' + cls : '');
  r.hidden = false;
}

// ---------- source + handle auto-detect ----------

function detectFromUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return { source: null, handle: null }; }
  const host = u.hostname.replace(/^www\./, '');
  const hit = SOURCE_HOSTS.find(h => host.endsWith(h.host));
  if (!hit) return { source: null, handle: null };

  // Handle patterns per platform. These only fire on profile URLs, not DM
  // conversation URLs (which usually don't contain the other person's handle).
  let handle = null;
  const path = u.pathname.replace(/\/+$/, '');
  if (hit.source === 'ig') {
    // instagram.com/<handle>/ or /<handle>/direct — the first segment
    const seg = path.split('/').filter(Boolean)[0];
    if (seg && !['direct', 'reels', 'explore', 'p', 'inbox'].includes(seg)) handle = seg;
  } else if (hit.source === 'x') {
    const seg = path.split('/').filter(Boolean)[0];
    if (seg && !['home', 'messages', 'notifications', 'explore', 'i', 'search'].includes(seg)) handle = seg;
  } else if (hit.source === 'tiktok') {
    // tiktok.com/@handle
    const m = path.match(/^\/@([^/]+)/);
    if (m) handle = m[1];
  } else if (hit.source === 'fetlife') {
    // fetlife.com/users/12345/or/handle-style-slug — hard to know; skip
  } else if (hit.source === 'bumble' || hit.source === 'tinder') {
    // No stable handle in URL for these; user types it.
  }
  return { source: hit.source, handle };
}

async function primeFromTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    const { source, handle } = detectFromUrl(tab.url);
    if (source) {
      $('#source').value = source;
      $('#imgSource').value = source;
    }
    if (handle) $('#handle').value = handle;
  } catch {}
}

// ---------- mode tabs ----------
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
    tab.classList.add('on');
    const mode = tab.dataset.mode;
    document.getElementById('mode-screenshot').hidden = mode !== 'screenshot';
    document.getElementById('mode-paste').hidden      = mode !== 'paste';
  });
});

// ---------- config ----------

let CONFIG = { baseUrl: '', token: '' };

async function loadConfig() {
  const s = await chrome.storage.local.get(['baseUrl', 'token']);
  CONFIG.baseUrl = (s.baseUrl || '').replace(/\/+$/, '');
  CONFIG.token   = s.token || '';
  if (!CONFIG.baseUrl || !CONFIG.token) {
    setStrip('Not configured — click ⚙ to set dashboard URL and token.', 'err');
    $('#captureBtn').disabled = true;
    return false;
  }
  setStrip('Connected to ' + CONFIG.baseUrl.replace(/^https:\/\//, ''), 'ok');
  return true;
}

// ---------- parsing ----------

/**
 * Parse the pasted transcript into an array of { direction, body } objects.
 * mode: 'prefix' | 'alt-his' | 'alt-mine'
 *
 * prefix: lines starting with `>` (any whitespace before) are from him;
 *   lines starting with `<` explicitly mark yours (optional); everything
 *   else is treated as yours. Consecutive same-direction lines are joined
 *   into one message with a newline between them.
 *
 * alt-his / alt-mine: each non-empty line is one message, alternating
 *   direction, starting with the specified sender.
 */
function parseTranscript(text, mode) {
  const raw = String(text || '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');

  if (mode === 'prefix') {
    const msgs = [];
    let cur = null;
    for (const line of lines) {
      if (!line.trim()) { cur = null; continue; } // blank line ends current message
      const m = line.match(/^\s*([<>])\s?(.*)$/);
      let direction, body;
      if (m) {
        direction = m[1] === '>' ? 'in' : 'out';
        body = m[2];
      } else {
        direction = 'out';
        body = line;
      }
      if (cur && cur.direction === direction) {
        cur.body += '\n' + body;
      } else {
        cur = { direction, body };
        msgs.push(cur);
      }
    }
    // Trim trailing empties from each body.
    return msgs.map(m => ({ ...m, body: m.body.trim() })).filter(m => m.body.length > 0);
  }

  // Alternating modes.
  const start = mode === 'alt-mine' ? 'out' : 'in';
  const msgs = [];
  let dir = start;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    msgs.push({ direction: dir, body: t });
    dir = dir === 'in' ? 'out' : 'in';
  }
  return msgs;
}

function updatePreview() {
  const msgs = parseTranscript($('#transcript').value, $('#mode').value);
  const inCount  = msgs.filter(m => m.direction === 'in').length;
  const outCount = msgs.filter(m => m.direction === 'out').length;
  if (msgs.length === 0) {
    setPreview('paste some messages…');
    return;
  }
  setPreview(`${msgs.length} messages · ${inCount} from him · ${outCount} from you`, 'ok');
}
$('#transcript').addEventListener('input', updatePreview);
$('#mode').addEventListener('change', updatePreview);

// ---------- capture ----------

$('#captureBtn').addEventListener('click', async () => {
  const source = $('#source').value;
  const handle = $('#handle').value.trim();
  const displayName = $('#displayName').value.trim();
  const bucket = $('#bucket').value;
  const mode   = $('#mode').value;
  const text   = $('#transcript').value;

  if (!handle) { setResult('His handle is required.', 'err'); return; }

  const messages = parseTranscript(text, mode);
  if (messages.length === 0) { setResult('No messages parsed. Check the format.', 'err'); return; }

  const btn = $('#captureBtn');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Sending…';
  try {
    const resp = await fetch(CONFIG.baseUrl + '/api/ingest', {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + CONFIG.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        source,
        contact: {
          external_id: handle,
          display_name: displayName || handle,
          bucket,
        },
        messages,
      }),
    });
    let data = null;
    try { data = await resp.json(); } catch {}
    if (!resp.ok) {
      const detail = data?.detail || data?.error || `HTTP ${resp.status}`;
      setResult('Capture failed: ' + detail, 'err');
      return;
    }
    const url = CONFIG.baseUrl + '/dashboard/#contact-' + data.contact.id;
    const createdBit = data.contact.created ? ' (new contact)' : '';
    setResult(
      `Sent ${data.added} new · ${data.existing} already there · ${data.rejected} rejected${createdBit}. ` +
      `<a href="${url}" target="_blank" rel="noopener">Open in dashboard</a>`,
      'ok'
    );
    // Clear the textarea so the next capture starts fresh.
    $('#transcript').value = '';
    updatePreview();
  } catch (e) {
    setResult('Network error: ' + (e?.message || 'unknown'), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

$('#settingsLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ---------- screenshot mode ----------

let pendingImage = null; // { base64, media_type, bytes, dataUrl }

const dropZone   = $('#dropZone');
const fileInput  = $('#fileInput');
const thumbWrap  = $('#thumbWrap');
const thumbImg   = $('#thumb');
const thumbInfo  = $('#thumbInfo');

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      // reader.result is a data: URL. Strip the header.
      const s = String(r.result);
      const commaIdx = s.indexOf(',');
      resolve({ dataUrl: s, base64: s.slice(commaIdx + 1), media_type: file.type || 'image/png', bytes: file.size });
    };
    r.onerror = () => reject(new Error('read_failed'));
    r.readAsDataURL(file);
  });
}

async function acceptImageFile(file) {
  if (!file || !file.type?.startsWith('image/')) {
    setResult('That doesn\'t look like an image.', 'err');
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    setResult('Image is too large (max 15 MB).', 'err');
    return;
  }
  try {
    const img = await fileToBase64(file);
    pendingImage = img;
    thumbImg.src = img.dataUrl;
    thumbInfo.textContent = `${img.media_type} · ${(img.bytes / 1024).toFixed(0)} KB`;
    thumbWrap.hidden = false;
    $('#captureImgBtn').disabled = false;
  } catch (e) {
    setResult('Couldn\'t read image: ' + e.message, 'err');
  }
}

// click-to-select
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) acceptImageFile(f);
});

// drag & drop
['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => {
  e.preventDefault(); e.stopPropagation();
  dropZone.classList.add('hover');
}));
['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => {
  e.preventDefault(); e.stopPropagation();
  dropZone.classList.remove('hover');
}));
dropZone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files?.[0];
  if (f) acceptImageFile(f);
});

// paste anywhere in the popup while screenshot mode is active
document.addEventListener('paste', (e) => {
  if (document.getElementById('mode-screenshot').hidden) return;
  for (const item of (e.clipboardData?.items || [])) {
    if (item.type?.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) { acceptImageFile(f); e.preventDefault(); return; }
    }
  }
});

// Capture the visible area of the current tab as a PNG. Chrome returns a
// data: URL; we split into base64 + media_type for consistency with the
// drag/drop path.
$('#captureTabBtn').addEventListener('click', async () => {
  const btn = $('#captureTabBtn');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Capturing…';
  try {
    // Close the popup momentarily so it doesn't cover the tab? Actually not
    // needed — captureVisibleTab captures the tab, not the popup overlay.
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    if (!dataUrl) throw new Error('Chrome returned nothing');
    const commaIdx = dataUrl.indexOf(',');
    const base64 = dataUrl.slice(commaIdx + 1);
    // Estimate byte size from base64 length.
    const bytes = Math.floor(base64.length * 0.75);
    pendingImage = { dataUrl, base64, media_type: 'image/png', bytes };
    thumbImg.src = dataUrl;
    thumbInfo.textContent = `image/png · ${(bytes / 1024).toFixed(0)} KB · captured tab`;
    thumbWrap.hidden = false;
    $('#captureImgBtn').disabled = false;
    setResult('', ''); // clear any previous result
    $('#result').hidden = true;
  } catch (e) {
    setResult(
      'Capture failed: ' + (e?.message || 'Chrome rejected the request. ' +
      'The tab may be a chrome:// page or extension page — those can\'t be captured.'),
      'err'
    );
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});

$('#clearThumb').addEventListener('click', (e) => {
  e.preventDefault();
  pendingImage = null;
  thumbImg.src = '';
  thumbWrap.hidden = true;
  fileInput.value = '';
  $('#captureImgBtn').disabled = true;
});

$('#captureImgBtn').addEventListener('click', async () => {
  if (!pendingImage) { setResult('Drop or select an image first.', 'err'); return; }
  const btn = $('#captureImgBtn');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span> Extracting…';
  try {
    const resp = await fetch(CONFIG.baseUrl + '/api/ingest-image', {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + CONFIG.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        image: pendingImage.base64,
        image_media_type: pendingImage.media_type,
        source: $('#imgSource').value || undefined,
        bucket: $('#imgBucket').value,
      }),
    });
    let data = null;
    try { data = await resp.json(); } catch {}
    if (!resp.ok) {
      const detail = data?.detail || data?.error || `HTTP ${resp.status}`;
      setResult('Extract failed: ' + detail, 'err');
      return;
    }
    const url = CONFIG.baseUrl + '/dashboard/';
    const created = data.contact?.created ? ' (new contact)' : '';
    const cost = data.usage ? ` · $${((data.usage.cost_micro_usd || 0) / 1_000_000).toFixed(4)}` : '';
    setResult(
      `Captured ${data.added} new · ${data.existing} already there · ${data.rejected} rejected${created}. ` +
      `Detected: <b>${data.detected?.display_name || data.detected?.handle}</b> on ${data.detected?.source}${cost}. ` +
      `<a href="${url}" target="_blank" rel="noopener">Open dashboard</a>`,
      'ok'
    );
    // Reset thumbnail so next screenshot starts fresh.
    pendingImage = null;
    thumbImg.src = '';
    thumbWrap.hidden = true;
    fileInput.value = '';
  } catch (e) {
    setResult('Network error: ' + (e?.message || 'unknown'), 'err');
  } finally {
    btn.disabled = pendingImage ? false : true;
    btn.textContent = originalLabel;
  }
});

// ---------- init ----------
(async () => {
  await loadConfig();
  await primeFromTab();
  updatePreview();
})();
