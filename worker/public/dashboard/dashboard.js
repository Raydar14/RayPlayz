// Ray · Dashboard — Phase 2 client
//
// Single-file vanilla JS driving the login flow and the two-pane inbox.
// Talks to /api/* endpoints defined in worker/src/api.js. Auth is via
// the rp_session cookie set on /api/login; all fetches use
// credentials:'same-origin' so the browser attaches it automatically.

(() => {
  // -------------------- shorthand --------------------
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const SOURCES = [
    ['ig',       'Instagram'],
    ['tinder',   'Tinder'],
    ['bumble',   'Bumble'],
    ['fetlife',  'Fetlife'],
    ['tiktok',   'TikTok'],
    ['x',        'X'],
    ['whatsapp', 'WhatsApp'],
  ];
  const STATUSES = ['new', 'warming', 'vetting', 'met', 'paying-fan', 'ghosted', 'blocked'];

  // -------------------- API helpers --------------------
  async function api(method, path, body) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const r = await fetch(path, init);
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok) {
      const e = new Error((data && data.error) || `HTTP ${r.status}`);
      e.status = r.status;
      e.detail = data && data.detail;
      throw e;
    }
    return data;
  }
  const GET   = (p)    => api('GET', p);
  const POST  = (p, b) => api('POST', p, b);
  const PATCH = (p, b) => api('PATCH', p, b);
  const DEL   = (p)    => api('DELETE', p);

  // -------------------- toasts --------------------
  const toastsEl = $('#toasts');
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    toastsEl.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2400);
    setTimeout(() => el.remove(), 2800);
  }

  // -------------------- state --------------------
  let currentBucket = 'all';
  let currentSearch = '';
  let currentContactId = null;
  let contacts = [];          // list cache
  let detail = null;          // full-detail cache for open contact
  let notesSaveTimer = null;
  let searchDebounce = null;

  // -------------------- view switching --------------------
  const loginView = $('#loginView');
  const appView   = $('#appView');
  function showLogin() {
    appView.classList.remove('on');
    loginView.style.display = 'flex';
    setTimeout(() => $('#pw').focus(), 30);
  }
  function showApp() {
    loginView.style.display = 'none';
    appView.classList.add('on');
  }

  // -------------------- login/logout --------------------
  async function checkMe() {
    try {
      const j = await GET('/api/me');
      if (j.authed) {
        $('#sess').textContent = fmtSess(j.session.expires);
        showApp();
        await bootApp();
      } else {
        showLogin();
      }
    } catch { showLogin(); }
  }
  function fmtSess(exp) {
    const ms = exp - Date.now();
    if (ms <= 0) return 'session expired';
    const hrs = Math.floor(ms / 3600000);
    if (hrs >= 24) return 'session ' + Math.floor(hrs / 24) + 'd ' + (hrs % 24) + 'h left';
    const mins = Math.floor((ms % 3600000) / 60000);
    return 'session ' + hrs + 'h ' + mins + 'm left';
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginBtn'); const errEl = $('#loginErr'); const pw = $('#pw');
    errEl.textContent = ''; btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const r = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: pw.value }),
      });
      if (r.ok) { pw.value = ''; await checkMe(); }
      else if (r.status === 401) errEl.textContent = 'Wrong password.';
      else errEl.textContent = 'Something went wrong. Try again.';
    } catch { errEl.textContent = 'Network error.'; }
    finally { btn.disabled = false; btn.textContent = 'Enter'; }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try { await POST('/api/logout'); } catch {}
    currentContactId = null; contacts = []; detail = null;
    showLogin();
  });

  // -------------------- settings (extension token) --------------------

  const settingsModal = $('#settingsModal');
  $('#settingsBtn').addEventListener('click', openSettings);
  settingsModal.addEventListener('click', (e) => { if (e.target.matches('[data-close]')) closeSettings(); });

  async function openSettings() {
    $('#tokenPlaintextBox').hidden = true;
    $('#tokenPlaintext').textContent = '';
    settingsModal.hidden = false;
    await loadTokenStatus();
  }
  function closeSettings() { settingsModal.hidden = true; }

  async function loadTokenStatus() {
    const status = $('#tokenStatus');
    const revokeBtn = $('#revokeTokenBtn');
    status.textContent = 'Loading…';
    try {
      const r = await GET('/api/settings/extension-token');
      if (r.active) {
        const created = new Date(r.token.created_at);
        const lastUsed = r.token.last_used_at ? new Date(r.token.last_used_at) : null;
        status.innerHTML =
          `<span style="color:#7cf0a4">● Active</span> · created ${created.toLocaleDateString()} · ` +
          (lastUsed ? `last used ${lastUsed.toLocaleString()}` : 'never used yet');
        revokeBtn.hidden = false;
      } else {
        status.innerHTML = '<span style="color:var(--dim)">○ No token generated yet</span>';
        revokeBtn.hidden = true;
      }
    } catch (e) {
      status.textContent = 'Failed to load: ' + (e.detail || e.message);
    }
  }

  $('#rotateTokenBtn').addEventListener('click', async () => {
    const btn = $('#rotateTokenBtn');
    if (!confirm('Generate a new token? Any existing extension token will stop working immediately.')) return;
    btn.disabled = true;
    try {
      const r = await POST('/api/settings/extension-token/rotate', {});
      $('#tokenPlaintext').textContent = r.token;
      $('#tokenPlaintextBox').hidden = false;
      await loadTokenStatus();
    } catch (e) {
      toast('Failed: ' + (e.detail || e.message), 'err');
    } finally { btn.disabled = false; }
  });

  $('#revokeTokenBtn').addEventListener('click', async () => {
    if (!confirm('Revoke the active extension token? The extension will stop working until a new one is generated.')) return;
    try {
      await POST('/api/settings/extension-token/revoke', {});
      $('#tokenPlaintextBox').hidden = true;
      await loadTokenStatus();
    } catch (e) { toast('Failed: ' + (e.detail || e.message), 'err'); }
  });

  $('#copyTokenBtn').addEventListener('click', async () => {
    const t = $('#tokenPlaintext').textContent;
    try {
      await navigator.clipboard.writeText(t);
      const b = $('#copyTokenBtn');
      b.textContent = 'Copied ✓';
      setTimeout(() => { b.textContent = 'Copy token'; }, 1500);
    } catch { toast('Copy failed — select the token and copy manually', 'err'); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!settingsModal.hidden) closeSettings();
    }
  });

  // -------------------- boot the app --------------------
  async function bootApp() {
    await Promise.all([loadCounts(), loadContacts(), loadUsage()]);
  }

  async function loadUsage() {
    try {
      const u = await GET('/api/ai-usage');
      const chip = $('#usage');
      const monthly = Number(u.month_usd || 0);
      chip.textContent = '$' + monthly.toFixed(2) + ' / mo';
      chip.title = `AI spend: $${Number(u.today_usd||0).toFixed(2)} today · ` +
                   `$${Number(u.week_usd||0).toFixed(2)} this week · ` +
                   `$${monthly.toFixed(2)} this month · ` +
                   `${u.total_calls||0} calls (${u.errors||0} errors)`;
      chip.classList.toggle('warm', monthly > 5);
      chip.classList.toggle('hot', monthly > 15);
    } catch {}
  }

  async function loadCounts() {
    try {
      const c = await GET('/api/counts');
      $('#c-all').textContent    = c.all ?? 0;
      $('#c-dating').textContent = c.dating ?? 0;
      $('#c-fan').textContent    = c.fan ?? 0;
    } catch (e) { console.error(e); }
  }

  async function loadContacts() {
    const q = new URLSearchParams();
    if (currentBucket && currentBucket !== 'all') q.set('bucket', currentBucket);
    if (currentSearch) q.set('q', currentSearch);
    try {
      const data = await GET('/api/contacts?' + q.toString());
      contacts = data.contacts || [];
      renderList();
    } catch (e) { toast('Failed to load contacts: ' + e.message, 'err'); }
  }

  // -------------------- filter chips --------------------
  $('#filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $$('#filters .chip').forEach(c => { c.classList.remove('on'); c.setAttribute('aria-selected', 'false'); });
    chip.classList.add('on'); chip.setAttribute('aria-selected', 'true');
    currentBucket = chip.dataset.bucket;
    loadContacts();
  });

  // -------------------- search --------------------
  $('#search').addEventListener('input', (e) => {
    currentSearch = e.target.value.trim();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadContacts, 220);
  });

  // -------------------- contact list rendering --------------------
  function renderList() {
    const listEl = $('#contactList');
    listEl.innerHTML = '';
    if (contacts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-list';
      if (currentSearch || currentBucket !== 'all') {
        empty.innerHTML = '<p>No matches. Try clearing filters.</p>';
      } else {
        empty.innerHTML = '<p>No contacts yet.</p>';
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary btn-sm';
        btn.textContent = '+ Add your first contact';
        btn.addEventListener('click', openNewContact);
        empty.appendChild(btn);
      }
      listEl.appendChild(empty);
      return;
    }
    for (const c of contacts) listEl.appendChild(renderContactItem(c));
  }

  function renderContactItem(c) {
    const el = document.createElement('div');
    el.className = 'contact-item' + (c.id === currentContactId ? ' active' : '');
    el.setAttribute('role', 'listitem');
    el.tabIndex = 0;

    const row1 = document.createElement('div'); row1.className = 'row1';
    const name = document.createElement('div'); name.className = 'name'; name.textContent = c.display_name;
    const dots = document.createElement('div'); dots.className = 'dots';
    for (const [key] of SOURCES) {
      if (c['handle_' + key]) {
        const d = document.createElement('span');
        d.className = 'dot src-' + key;
        d.title = key + ': ' + c['handle_' + key];
        dots.appendChild(d);
      }
    }
    row1.appendChild(name); row1.appendChild(dots);

    const row2 = document.createElement('div'); row2.className = 'row2';
    const status = document.createElement('span');
    status.className = 'status s-' + c.status;
    status.textContent = c.status;
    const preview = document.createElement('span'); preview.className = 'preview';
    if (c.last_body) {
      const span = document.createElement('span');
      span.className = c.last_direction === 'out' ? 'out' : 'in';
      span.textContent = c.last_body.length > 80 ? c.last_body.slice(0, 80) + '…' : c.last_body;
      preview.appendChild(span);
    } else {
      preview.textContent = 'no messages yet';
    }
    row2.appendChild(status); row2.appendChild(preview);

    el.appendChild(row1); el.appendChild(row2);

    el.addEventListener('click', () => openContact(c.id));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openContact(c.id); });
    return el;
  }

  // -------------------- detail rendering --------------------
  async function openContact(id) {
    currentContactId = id;
    appView.classList.add('viewing-detail');
    $$('.contact-item').forEach(el => el.classList.remove('active'));
    // highlight in list
    for (const el of $$('.contact-item')) {
      // we don't have data-id on the item; re-render the list instead for correctness
    }
    renderList();
    $('#detailEmpty').hidden = true;
    $('#detailBody').hidden = false;
    $('#detailBody').innerHTML = '<div style="padding:40px; text-align:center; color:var(--mute)">Loading…</div>';
    try {
      detail = await GET('/api/contacts/' + id);
      renderDetail();
    } catch (e) {
      $('#detailBody').innerHTML = '<div style="padding:40px; text-align:center; color:var(--err)">Failed: ' + e.message + '</div>';
    }
  }

  function renderDetail() {
    const c = detail.contact;
    const body = $('#detailBody');
    body.innerHTML = '';

    // ---- header ----
    const dh = el('div', 'dh');
    const nameInput = el('input', 'name-input'); nameInput.type = 'text'; nameInput.value = c.display_name; nameInput.maxLength = 200;
    nameInput.addEventListener('blur', () => saveField('display_name', nameInput.value.trim() || c.display_name));

    const bucketSel = el('select'); for (const b of ['dating', 'fan']) bucketSel.appendChild(opt(b, b === 'dating' ? 'Dating' : 'Fan'));
    bucketSel.value = c.bucket;
    bucketSel.addEventListener('change', () => saveField('bucket', bucketSel.value));

    const statusSel = el('select'); for (const s of STATUSES) statusSel.appendChild(opt(s, s));
    statusSel.value = c.status;
    statusSel.addEventListener('change', () => saveField('status', statusSel.value));

    const delBtn = el('button', 'btn btn-ghost btn-sm delete-btn');
    delBtn.type = 'button'; delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', deleteContact);

    dh.appendChild(nameInput);
    const scoreBadge = renderScoreBadge(c);
    if (scoreBadge) dh.appendChild(scoreBadge);
    dh.appendChild(bucketSel); dh.appendChild(statusSel); dh.appendChild(delBtn);
    body.appendChild(dh);

    // ---- hard-rule gate warning ----
    const gateWarn = renderGateWarning(c);
    if (gateWarn) body.appendChild(gateWarn);

    // ---- AI: scan + drafts + flags ----
    body.appendChild(renderAIPanel());

    // ---- handles ----
    body.appendChild(renderHandlesSection(c));

    // ---- vetting: hard filters ----
    body.appendChild(renderHardFiltersSection(c));

    // ---- vetting: soft signals ----
    body.appendChild(renderSoftSignalsSection(c));

    // ---- gate: long-term named ----
    body.appendChild(renderGate(c));

    // ---- notes ----
    body.appendChild(renderNotesSection(c));

    // ---- tags ----
    body.appendChild(renderTagsSection());

    // ---- follow-ups ----
    body.appendChild(renderFollowUpsSection());

    // ---- thread ----
    body.appendChild(renderThreadSection());

    // ---- add-message ----
    body.appendChild(renderMsgForm());
  }

  function renderHandlesSection(c) {
    const s = section('Handles');
    const grid = el('div', 'grid');
    for (const [key, label] of SOURCES) {
      const l = el('label'); l.textContent = label;
      const inp = el('input'); inp.type = 'text'; inp.maxLength = 200;
      inp.value = c['handle_' + key] || ''; inp.placeholder = 'blank if not on ' + label;
      inp.addEventListener('blur', () => saveField('handle_' + key, inp.value.trim() || null));
      l.appendChild(inp); grid.appendChild(l);
    }
    s.appendChild(grid); return s;
  }

  function renderHardFiltersSection(c) {
    const s = section('Hard filters');
    const grid = el('div', 'grid');

    // location kind
    grid.appendChild(labelWith('Location', selectField(
      [['', '—'], ['local', 'Local (CR)'], ['visiting', 'Visiting'], ['remote', 'Remote']],
      c.location_kind || '',
      v => saveField('location_kind', v || null),
    )));

    // location note
    grid.appendChild(labelWith('Location detail', textField(c.location_note || '', 'e.g. Manuel Antonio, 2 wks',
      v => saveField('location_note', v || null))));

    // height
    grid.appendChild(labelWith('Height (cm) — 183 = 6ft', numField(c.height_cm, '183',
      v => saveField('height_cm', v == null ? null : v))));

    // speaks spanish + english
    grid.appendChild(labelWith('Speaks Spanish', triState(c.speaks_spanish, v => saveField('speaks_spanish', v))));
    grid.appendChild(labelWith('Speaks English', triState(c.speaks_english, v => saveField('speaks_english', v))));

    s.appendChild(grid); return s;
  }

  function renderSoftSignalsSection(c) {
    const s = section('Signals');
    const grid = el('div', 'grid');
    grid.appendChild(labelWith('Feminist-aligned',         triState(c.feminist_aligned,     v => saveField('feminist_aligned', v))));
    grid.appendChild(labelWith('Dominant + gentle',        triState(c.dom_gentle,           v => saveField('dom_gentle', v))));
    grid.appendChild(labelWith('Handles strong woman',     triState(c.handles_strong_woman, v => saveField('handles_strong_woman', v))));
    grid.appendChild(labelWith('Poly-literate',            triState(c.poly_literate,        v => saveField('poly_literate', v))));
    grid.appendChild(labelWith('Kink-literate',            triState(c.kink_literate,        v => saveField('kink_literate', v))));
    grid.appendChild(labelWith('Met in person',            triState(c.met_in_person,        v => saveField('met_in_person', v == null ? 0 : v))));
    s.appendChild(grid); return s;
  }

  function renderGate(c) {
    const gate = el('div', 'gate-row');
    const left = el('div');
    const label = el('div', 'gate-label'); label.textContent = 'Long-term named connections (2+, romantic or not)';
    const sub = el('div', 'gate-sub'); sub.textContent = 'Hard rule: don’t advance past vetting until this is confirmed.';
    left.appendChild(label); left.appendChild(sub);

    const btn = el('button', 'gate-btn' + (c.long_term_named_confirmed ? ' confirmed' : ''));
    btn.type = 'button';
    btn.textContent = c.long_term_named_confirmed ? '✓ Confirmed' : 'Mark confirmed';
    btn.addEventListener('click', async () => {
      const next = c.long_term_named_confirmed ? 0 : 1;
      await saveField('long_term_named_confirmed', next);
      c.long_term_named_confirmed = next;
      btn.textContent = next ? '✓ Confirmed' : 'Mark confirmed';
      btn.classList.toggle('confirmed', !!next);
    });
    gate.appendChild(left); gate.appendChild(btn);
    return gate;
  }

  function renderNotesSection(c) {
    const s = section('Notes');
    const ta = el('textarea', 'notes-area');
    ta.placeholder = 'Red flags. Kinks discussed. Hard limits. What he said his name was. Anything.';
    ta.value = c.notes || '';
    const hint = el('div', 'autosave-hint'); hint.textContent = 'autosaves';
    ta.addEventListener('input', () => {
      clearTimeout(notesSaveTimer);
      hint.textContent = 'typing…';
      notesSaveTimer = setTimeout(async () => {
        try { await saveField('notes', ta.value); hint.textContent = 'saved'; }
        catch { hint.textContent = 'save failed'; }
      }, 600);
    });
    s.appendChild(ta); s.appendChild(hint); return s;
  }

  function renderTagsSection() {
    const s = section('Tags');
    const row = el('div', 'tags-row');
    for (const t of detail.tags) row.appendChild(tagChip(t));

    const addBtn = el('button', 'tag-add'); addBtn.type = 'button'; addBtn.textContent = '+ add tag';
    addBtn.addEventListener('click', () => {
      const inp = el('input', 'tag-input'); inp.type = 'text'; inp.maxLength = 80; inp.placeholder = 'tag';
      addBtn.replaceWith(inp); inp.focus();
      const commit = async () => {
        const tag = inp.value.trim();
        inp.replaceWith(addBtn);
        if (!tag) return;
        try {
          await POST('/api/contacts/' + currentContactId + '/tags', { tag });
          if (!detail.tags.includes(tag)) detail.tags.push(tag);
          row.insertBefore(tagChip(tag), addBtn);
        } catch (e) { toast(e.message, 'err'); }
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    });
    row.appendChild(addBtn);
    s.appendChild(row); return s;
  }
  function tagChip(tag) {
    const chip = el('span', 'tag'); chip.textContent = tag;
    const x = el('button'); x.type = 'button'; x.textContent = '×'; x.title = 'remove';
    x.addEventListener('click', async () => {
      try {
        await DEL('/api/contacts/' + currentContactId + '/tags/' + encodeURIComponent(tag));
        detail.tags = detail.tags.filter(t => t !== tag);
        chip.remove();
      } catch (e) { toast(e.message, 'err'); }
    });
    chip.appendChild(x); return chip;
  }

  function renderFollowUpsSection() {
    const s = section('Follow-ups');
    const list = el('div');
    for (const f of detail.follow_ups.filter(f => !f.completed_at)) {
      list.appendChild(followUpRow(f));
    }
    s.appendChild(list);

    const add = el('div', 'fu-add');
    const when = el('input'); when.type = 'datetime-local';
    const now = new Date(Date.now() + 24 * 3600 * 1000);
    when.value = toLocalDatetime(now);
    const note = el('input'); note.type = 'text'; note.placeholder = 'nudge him if no reply…'; note.maxLength = 500;
    const btn = el('button', 'btn btn-ghost btn-sm'); btn.type = 'button'; btn.textContent = 'Add';
    btn.addEventListener('click', async () => {
      const remind_at = new Date(when.value).getTime();
      if (!Number.isFinite(remind_at)) { toast('bad date', 'err'); return; }
      try {
        const r = await POST('/api/contacts/' + currentContactId + '/follow-ups', { remind_at, note: note.value.trim() || null });
        const fu = { id: r.id, contact_id: currentContactId, remind_at, note: note.value.trim() || null, completed_at: null };
        detail.follow_ups.push(fu);
        list.appendChild(followUpRow(fu));
        note.value = '';
      } catch (e) { toast(e.message, 'err'); }
    });
    add.appendChild(when); add.appendChild(note); add.appendChild(btn);
    s.appendChild(add);
    return s;
  }
  function followUpRow(f) {
    const row = el('div', 'followup' + (f.remind_at < Date.now() ? ' overdue' : ''));
    const when = el('span', 'when'); when.textContent = fmtWhen(f.remind_at);
    const note = el('span', 'note'); note.textContent = f.note || '(no note)';
    const done = el('button'); done.type = 'button'; done.title = 'mark done'; done.textContent = '✓';
    done.addEventListener('click', async () => {
      try {
        await PATCH('/api/follow-ups/' + f.id, { completed: true });
        row.remove();
        f.completed_at = Date.now();
      } catch (e) { toast(e.message, 'err'); }
    });
    row.appendChild(when); row.appendChild(note); row.appendChild(done);
    return row;
  }

  function renderThreadSection() {
    const s = section('Thread');
    const thread = el('div', 'thread');
    if (detail.messages.length === 0) {
      const p = el('p'); p.style.color = 'var(--mute)'; p.style.fontSize = '.88rem';
      p.textContent = 'No messages captured yet. Add one below.';
      thread.appendChild(p);
    } else {
      for (const m of detail.messages) thread.appendChild(msgBubble(m));
    }
    s.appendChild(thread); return s;
  }
  function msgBubble(m) {
    const b = el('div', 'msg ' + m.direction);
    const body = document.createElement('span'); body.textContent = m.body;
    b.appendChild(body);
    const meta = el('div', 'meta');
    const src = el('span', 'src src-' + m.source); src.textContent = m.source;
    const when = el('span'); when.textContent = fmtWhen(m.sent_at || m.ingested_at);
    const del = el('button', 'del'); del.type = 'button'; del.title = 'delete'; del.textContent = '×';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this message?')) return;
      try {
        await DEL('/api/messages/' + m.id);
        detail.messages = detail.messages.filter(x => x.id !== m.id);
        b.remove();
      } catch (e) { toast(e.message, 'err'); }
    });
    meta.appendChild(src); meta.appendChild(when); meta.appendChild(del);
    b.appendChild(meta);
    return b;
  }

  function renderMsgForm() {
    const form = el('form', 'msg-form');
    const src = el('select'); for (const [k, l] of SOURCES) src.appendChild(opt(k, l));
    // default source: last one used, else IG
    const lastSrc = detail.messages.at(-1)?.source || detail.contact.handle_ig ? 'ig' : SOURCES[0][0];
    src.value = SOURCES.find(([k]) => k === lastSrc) ? lastSrc : 'ig';

    const dir = el('select');
    dir.appendChild(opt('in', 'from him'));
    dir.appendChild(opt('out', 'from me'));

    const body = el('textarea'); body.placeholder = 'Message text…'; body.rows = 2; body.maxLength = 100000;

    const btn = el('button', 'btn btn-primary'); btn.type = 'submit'; btn.textContent = 'Add';

    form.appendChild(src); form.appendChild(dir); form.appendChild(body); form.appendChild(btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = body.value.trim();
      if (!text) return;
      btn.disabled = true;
      try {
        const r = await POST('/api/contacts/' + currentContactId + '/messages', {
          source: src.value, direction: dir.value, body: text,
        });
        const newMsg = {
          id: r.id, source: src.value, direction: dir.value, body: text,
          sent_at: null, ingested_at: Date.now(),
        };
        detail.messages.push(newMsg);
        // append inline instead of full re-render
        const thread = $('.thread', $('#detailBody'));
        // remove "No messages yet" if present
        thread.querySelectorAll('p').forEach(p => p.remove());
        thread.appendChild(msgBubble(newMsg));
        thread.scrollIntoView({ behavior: 'smooth', block: 'end' });
        body.value = '';
        // refresh list preview
        loadContacts();
      } catch (e2) { toast(e2.message, 'err'); }
      finally { btn.disabled = false; }
    });
    return form;
  }

  // -------------------- AI panel (Phase 4) --------------------

  function renderScoreBadge(c) {
    const s = c.signal_score;
    if (s == null) return null;
    const cls = s > 0 ? 'pos' : s < 0 ? 'neg' : 'zero';
    const b = el('span', 'score-badge ' + cls);
    const lbl = el('span', 'lbl'); lbl.textContent = 'score';
    const val = el('span'); val.textContent = (s > 0 ? '+' : '') + s;
    b.appendChild(lbl); b.appendChild(val);
    return b;
  }

  function renderGateWarning(c) {
    // Warn if the person is at or past vetting but the hard rule isn't cleared.
    const gated = ['vetting', 'met', 'paying-fan'].includes(c.status);
    if (!gated) return null;
    if (c.long_term_named_confirmed) return null;
    const w = el('div', 'gate-warn');
    w.textContent = "Hard rule not cleared: no long-term named connections confirmed yet. Don't advance past vetting until this is verified.";
    return w;
  }

  function renderAIPanel() {
    const wrap = el('div', 'ai-panel');
    const h = el('h3'); h.textContent = 'AI · analysis + drafts';
    wrap.appendChild(h);

    const actions = el('div', 'ai-actions');
    const scanBtn = el('button', 'btn btn-primary btn-sm'); scanBtn.type = 'button'; scanBtn.textContent = 'Scan messages';
    const draftBtn = el('button', 'btn btn-ghost btn-sm'); draftBtn.type = 'button'; draftBtn.textContent = 'Draft replies';
    const cost = el('span', 'ai-cost'); cost.id = 'aiCost';
    actions.appendChild(scanBtn); actions.appendChild(draftBtn); actions.appendChild(cost);
    wrap.appendChild(actions);

    // container populated on demand (scan / draft results) and initially with existing flags
    const content = el('div'); content.className = 'ai-content';
    wrap.appendChild(content);
    renderExistingFlagsInto(content);

    scanBtn.addEventListener('click', async () => {
      scanBtn.disabled = true; draftBtn.disabled = true;
      scanBtn.innerHTML = '<span class="spinner"></span> Scanning…';
      try {
        const res = await POST('/api/contacts/' + currentContactId + '/scan', {});
        detail.flags = res.flags || [];
        detail.contact.signal_score = res.signal_score;
        cost.textContent = formatCost(res.usage) + ` · ${res.usage.latency_ms}ms`;
        renderScanResultInto(content, res);
        // Redraw header so the score badge appears / updates.
        renderDetail();
        loadUsage();
      } catch (e) {
        toast('Scan failed: ' + (e.detail || e.message), 'err');
      } finally {
        scanBtn.disabled = false; draftBtn.disabled = false;
        scanBtn.textContent = 'Scan messages';
      }
    });

    draftBtn.addEventListener('click', async () => {
      scanBtn.disabled = true; draftBtn.disabled = true;
      draftBtn.innerHTML = '<span class="spinner"></span> Drafting…';
      try {
        const res = await POST('/api/contacts/' + currentContactId + '/drafts', {});
        cost.textContent = formatCost(res.usage) + ` · ${res.usage.latency_ms}ms`;
        renderDraftsInto(content, res);
        loadUsage();
      } catch (e) {
        toast('Draft failed: ' + (e.detail || e.message), 'err');
      } finally {
        scanBtn.disabled = false; draftBtn.disabled = false;
        draftBtn.textContent = 'Draft replies';
      }
    });

    return wrap;
  }

  function formatCost(u) {
    if (!u) return '';
    const usd = (u.cost_micro_usd || 0) / 1_000_000;
    return usd < 0.001 ? '<$0.001' : ('$' + usd.toFixed(4));
  }

  function renderExistingFlagsInto(container) {
    container.innerHTML = '';
    if (!detail.flags || detail.flags.length === 0) {
      const p = el('p', 'ai-empty');
      p.textContent = 'No scan yet. Click "Scan messages" to analyze this thread, or "Draft replies" to generate response options.';
      container.appendChild(p);
      return;
    }
    renderFlagsInto(container, detail.flags);
  }

  function renderScanResultInto(container, res) {
    container.innerHTML = '';
    if (res.recommend_action) {
      const rec = el('div');
      const pill = el('span', 'rec-pill rec-' + res.recommend_action);
      pill.textContent = res.recommend_action.replace('_', ' ');
      rec.appendChild(document.createTextNode('Recommendation: '));
      rec.appendChild(pill);
      rec.style.marginTop = '10px';
      rec.style.fontSize = '.85rem';
      rec.style.color = 'var(--mute)';
      container.appendChild(rec);
    }
    if (res.overall_read) {
      const r = el('div', 'ai-read');
      r.textContent = res.overall_read;
      container.appendChild(r);
    }
    renderFlagsInto(container, res.flags);
  }

  function renderFlagsInto(container, flags) {
    if (!flags || !flags.length) return;
    const wrap = el('div', 'flags-section');
    for (const cat of ['positive', 'negative', 'gate']) {
      const list = flags.filter(f => f.category === cat);
      if (!list.length) continue;
      const box = el('div', 'flags-cat ' + cat);
      const h = el('h4'); h.textContent = cat + ' · ' + list.length;
      box.appendChild(h);
      for (const f of list) {
        const row = el('div', 'flag');
        const top = el('div');
        const rule = el('span', 'rule'); rule.textContent = f.rule_id;
        const w = el('span', 'weight ' + (f.weight > 0 ? 'pos' : f.weight < 0 ? 'neg' : ''));
        w.textContent = (f.weight > 0 ? '+' : '') + f.weight;
        top.appendChild(rule); top.appendChild(w);
        row.appendChild(top);
        if (f.evidence) {
          const ev = el('div', 'evidence'); ev.textContent = '"' + f.evidence + '"';
          row.appendChild(ev);
        }
        box.appendChild(row);
      }
      wrap.appendChild(box);
    }
    container.appendChild(wrap);
  }

  function renderDraftsInto(container, res) {
    // Wipe container so drafts + read replace whatever was there.
    container.innerHTML = '';
    if (res.read_of_thread) {
      const r = el('div', 'ai-read');
      r.textContent = res.read_of_thread;
      container.appendChild(r);
    }
    const wrap = el('div', 'drafts');
    for (const d of res.drafts) wrap.appendChild(draftRow(d));
    container.appendChild(wrap);
  }

  function draftRow(d) {
    const box = el('div', 'draft');
    const tone = el('span', 'tone ' + d.tone); tone.textContent = d.tone.replace('-', ' ');
    const text = el('div', 'text'); text.textContent = d.text;
    box.appendChild(tone); box.appendChild(text);
    if (d.rationale) {
      const why = el('div', 'why'); why.textContent = d.rationale;
      box.appendChild(why);
    }
    const row = el('div', 'row');
    const copy = el('button', 'copy'); copy.type = 'button'; copy.textContent = 'Copy';
    const use = el('button', 'use'); use.type = 'button'; use.textContent = 'Use as message';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(d.text);
        copy.classList.add('copied'); copy.textContent = 'Copied ✓';
        setTimeout(() => { copy.classList.remove('copied'); copy.textContent = 'Copy'; }, 1500);
      } catch { toast('Copy failed — select and copy manually', 'err'); }
    });
    use.addEventListener('click', () => {
      // Prefill the add-message form with this draft and set direction to 'from me'.
      const form = document.querySelector('#detailBody .msg-form');
      if (!form) return;
      const ta = form.querySelector('textarea');
      const dirSel = form.querySelectorAll('select')[1];
      if (ta) { ta.value = d.text; ta.focus(); }
      if (dirSel) dirSel.value = 'out';
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    row.appendChild(copy); row.appendChild(use);
    box.appendChild(row);
    return box;
  }

  // -------------------- save helpers --------------------
  async function saveField(field, value) {
    try {
      await PATCH('/api/contacts/' + currentContactId, { [field]: value });
      // update local caches quietly
      if (detail && detail.contact) detail.contact[field] = value;
      // If the change affects the list (name/status/bucket/handles), reload list.
      if (field === 'display_name' || field === 'status' || field === 'bucket' || field.startsWith('handle_')) {
        loadContacts(); loadCounts();
      }
    } catch (e) {
      toast('Save failed: ' + (e.detail || e.message), 'err');
    }
  }

  async function deleteContact() {
    if (!currentContactId) return;
    if (!confirm('Delete this contact and everything under them? Cannot be undone.')) return;
    try {
      await DEL('/api/contacts/' + currentContactId);
      currentContactId = null; detail = null;
      $('#detailBody').hidden = true;
      $('#detailEmpty').hidden = false;
      appView.classList.remove('viewing-detail');
      await Promise.all([loadContacts(), loadCounts()]);
    } catch (e) { toast(e.message, 'err'); }
  }

  // -------------------- new contact modal --------------------
  const modal = $('#modal');
  function openNewContact() {
    $('#modalForm').reset();
    $('#modalErr').textContent = '';
    modal.hidden = false;
    setTimeout(() => modal.querySelector('input[name=display_name]').focus(), 30);
  }
  function closeModal() { modal.hidden = true; }
  $('#newContactBtn').addEventListener('click', openNewContact);
  $('#emptyListAdd')?.addEventListener('click', openNewContact);
  modal.addEventListener('click', (e) => { if (e.target.matches('[data-close]')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submit = $('#modalSubmit'); const errEl = $('#modalErr');
    const fd = new FormData(e.target);
    const payload = {};
    for (const [k, v] of fd.entries()) {
      const t = String(v).trim();
      if (t) payload[k] = t;
    }
    if (!payload.display_name || !payload.bucket) { errEl.textContent = 'Name and bucket are required.'; return; }
    submit.disabled = true; errEl.textContent = '';
    try {
      const r = await POST('/api/contacts', payload);
      closeModal();
      await Promise.all([loadContacts(), loadCounts()]);
      if (r.id) openContact(r.id);
    } catch (err) {
      errEl.textContent = 'Failed: ' + (err.detail || err.message);
    } finally { submit.disabled = false; }
  });

  // -------------------- DOM helpers --------------------
  function el(tag, className) { const e = document.createElement(tag); if (className) e.className = className; return e; }
  function opt(value, label) { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; }
  function section(title) {
    const s = el('div', 'section');
    const h = el('h3'); h.textContent = title;
    s.appendChild(h);
    return s;
  }
  function labelWith(text, child) {
    const l = el('label'); l.textContent = text; l.appendChild(child); return l;
  }
  function textField(value, placeholder, onSave) {
    const i = el('input'); i.type = 'text'; i.value = value; i.placeholder = placeholder; i.maxLength = 500;
    i.addEventListener('blur', () => onSave(i.value.trim()));
    return i;
  }
  function numField(value, placeholder, onSave) {
    const i = el('input'); i.type = 'number'; i.min = 0; i.max = 300; i.value = value == null ? '' : value; i.placeholder = placeholder;
    i.addEventListener('blur', () => {
      const t = i.value.trim(); if (!t) return onSave(null);
      const n = Number(t); if (!Number.isInteger(n)) return onSave(null);
      onSave(n);
    });
    return i;
  }
  function selectField(options, value, onSave) {
    const s = el('select');
    for (const [v, l] of options) s.appendChild(opt(v, l));
    s.value = value;
    s.addEventListener('change', () => onSave(s.value));
    return s;
  }
  function triState(value, onSave) {
    // value: null (unknown) | 0 (no) | 1 (yes)
    const wrap = el('div', 'tristate');
    const bYes = el('button'); bYes.type = 'button'; bYes.textContent = 'Yes';
    const bUnk = el('button'); bUnk.type = 'button'; bUnk.textContent = '?';
    const bNo  = el('button'); bNo.type  = 'button'; bNo.textContent  = 'No';
    function paint(v) {
      bYes.classList.toggle('on-yes', v === 1);
      bUnk.classList.toggle('on-unk', v == null);
      bNo.classList.toggle('on-no',   v === 0);
    }
    paint(value);
    bYes.addEventListener('click', () => { paint(1);    onSave(1); });
    bUnk.addEventListener('click', () => { paint(null); onSave(null); });
    bNo.addEventListener('click',  () => { paint(0);    onSave(0); });
    wrap.appendChild(bYes); wrap.appendChild(bUnk); wrap.appendChild(bNo);
    return wrap;
  }

  // -------------------- misc format --------------------
  function fmtWhen(ms) {
    if (!ms) return '';
    const d = new Date(ms), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'yesterday ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function toLocalDatetime(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // -------------------- kick it off --------------------
  checkMe();
})();
