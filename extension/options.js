// Options page: store baseUrl + token in chrome.storage.local. Provide a
// Test button that hits GET /api/settings/extension-token/... equivalent
// via a lightweight ping — POST /api/ingest with an empty body returns
// 400 for a valid token and 401 for a bad one, which is enough of a probe
// without inserting anything.

const $ = (s) => document.querySelector(s);
const baseInput  = $('#baseUrl');
const tokenInput = $('#token');
const statusEl   = $('#status');

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

async function load() {
  const stored = await chrome.storage.local.get(['baseUrl', 'token']);
  baseInput.value  = stored.baseUrl || 'https://rayplayz.delicate-rain-ccdb.workers.dev';
  tokenInput.value = stored.token   || '';
}

function normalizeBase(u) {
  return (u || '').trim().replace(/\/+$/, '');
}

$('#saveBtn').addEventListener('click', async () => {
  const baseUrl = normalizeBase(baseInput.value);
  const token   = tokenInput.value.trim();
  if (!/^https:\/\//.test(baseUrl)) { setStatus('Dashboard URL must start with https://', 'err'); return; }
  if (!/^rpx_[a-z0-9]{32,64}$/i.test(token)) { setStatus('Token must start with rpx_ (paste from dashboard).', 'err'); return; }
  await chrome.storage.local.set({ baseUrl, token });
  setStatus('Saved. You can close this tab.', 'ok');
});

$('#testBtn').addEventListener('click', async () => {
  const baseUrl = normalizeBase(baseInput.value);
  const token   = tokenInput.value.trim();
  if (!baseUrl || !token) { setStatus('Fill both fields first.', 'err'); return; }
  const btn = $('#testBtn');
  btn.disabled = true;
  setStatus('Testing…', 'info');
  try {
    // A deliberately-invalid body gives us a 400 with a valid token,
    // a 401 with a bad token. Either proves connectivity.
    const r = await fetch(baseUrl + '/api/ingest', {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (r.status === 401) setStatus('Token is invalid or revoked. Regenerate in the dashboard.', 'err');
    else if (r.status === 400) setStatus('Connected. Token accepted.', 'ok');
    else if (r.status >= 200 && r.status < 300) setStatus('Connected. Unexpected success on empty body — safe to save.', 'ok');
    else setStatus('Reached the server but got HTTP ' + r.status, 'err');
  } catch (e) {
    setStatus('Network error: ' + (e?.message || 'unknown'), 'err');
  } finally { btn.disabled = false; }
});

load();
