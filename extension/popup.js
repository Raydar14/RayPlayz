// Popup logic. Loads config, detects source from current tab, parses the
// pasted transcript into messages, posts to /api/ingest.

const $ = (s) => document.querySelector(s);

const SOURCE_HOSTS = [
  { host: 'instagram.com',    source: 'ig'      },
  { host: 'tinder.com',       source: 'tinder'  },
  { host: 'bumble.com',       source: 'bumble'  },
  { host: 'fetlife.com',      source: 'fetlife' },
  { host: 'tiktok.com',       source: 'tiktok'  },
  { host: 'x.com',            source: 'x'       },
  { host: 'twitter.com',      source: 'x'       },
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
    if (source) $('#source').value = source;
    if (handle) $('#handle').value = handle;
  } catch {}
}

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

// ---------- init ----------
(async () => {
  await loadConfig();
  await primeFromTab();
  updatePreview();
})();
