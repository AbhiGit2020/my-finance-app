// ============================================================
// store.js — Google Drive as single source of truth
// v3 — Drive always primary, Save = overwrite, Backup = manual
// ============================================================

const GOOGLE_CLIENT_ID = '356564967624-454aiiodg41u0l1ialidtmhlpj8erdtp.apps.googleusercontent.com';
const GOOGLE_SCOPES    = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER     = 'MyFinanceApp';
const DATA_FILENAME    = 'data.json';
const DB_SCHEMA_VERSION = 1;
const DATA_COLLECTION_KEYS = StockCore.DATA_COLLECTION_KEYS;

const SS_TOKEN  = 'hf_gtoken';
const SS_EXPIRY = 'hf_gtoken_exp';
const SS_FOLDER = 'hf_gfolder';
const SS_FILE   = 'hf_gfile';
const SS_FINNHUB = 'hf_finnhub_key';
const STOCK_FX_TO_SGD = StockCore.DEFAULT_FX_TO_SGD;

// ── Finnhub API key (kept out of source — stored locally only) ──
function getFinnhubKey() {
  let key = (localStorage.getItem(SS_FINNHUB) || '').trim();
  if (!key) {
    key = (prompt('Enter your Finnhub API key (free at finnhub.io). It is stored only in this browser\'s local storage, never in the app source.') || '').trim();
    if (key) localStorage.setItem(SS_FINNHUB, key);
  }
  return key;
}

let _db          = emptyDb();
let _accessToken = null;
let _folderId    = null;
let _fileId      = null;
let _signedIn    = false;
let _dataReady   = false;
let _driveLoadFailed = false;
let _loadedDriveVersion = null;
let _loadedDriveModifiedTime = null;
let _baseDb = emptyDb();

// ── Empty DB ──────────────────────────────────────────────
function emptyDb() {
  return {
    schema_version: DB_SCHEMA_VERSION,
    stock_transactions:[], stock_prices:[], stock_watchlists:[],
    stock_tracker_symbols:[], stock_tracker_prices:[], fx_rates:[],
  };
}

function normalizeDb(data) {
  return { ...emptyDb(), ...StockCore.normalizeDatabase(data, DB_SCHEMA_VERSION) };
}

function cloneDb(data) {
  return JSON.parse(JSON.stringify(data));
}


// ── Global Profile Management ─────────────────────────────
const PROFILES = ['Abhi', 'Wife', 'Joint', 'Kids'];
const PROFILE_KEY = 'hf_active_profile';

function getActiveProfile() {
  return localStorage.getItem(PROFILE_KEY) || 'Abhi';
}

function setActiveProfile(name) {
  localStorage.setItem(PROFILE_KEY, name);
  document.querySelectorAll('.global-profile-sel').forEach(sel => sel.value = name);
  // Call page-specific profile change handler if defined, then re-render
  if (typeof window.onProfileChange === 'function') window.onProfileChange();
  if (typeof window.onDataLoaded === 'function') window.onDataLoaded();
}

function initProfileSelector() {
  const active = getActiveProfile();
  document.querySelectorAll('.global-profile-sel').forEach(sel => {
    sel.innerHTML = PROFILES.map(p => 
      `<option value="${p}" ${p === active ? 'selected' : ''}>${p}</option>`
    ).join('');
    sel.value = active;
    sel.onchange = () => setActiveProfile(sel.value);
  });
}

// ── Safe HTML helpers ────────────────────────────────────────
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}
function escapeAttr(value) {
  return escapeHtml(value);
}
function jsArg(value) {
  return escapeHtml(JSON.stringify(String(value ?? '')));
}

// ── Session ───────────────────────────────────────────────
function saveSession(token, expiresIn) {
  sessionStorage.setItem(SS_TOKEN, token);
  sessionStorage.setItem(SS_EXPIRY, (Date.now() + (expiresIn - 60) * 1000).toString());
}
function getSessionToken() {
  const t = sessionStorage.getItem(SS_TOKEN);
  const e = parseInt(sessionStorage.getItem(SS_EXPIRY) || '0');
  if (t && Date.now() < e) return t;
  sessionStorage.removeItem(SS_TOKEN); sessionStorage.removeItem(SS_EXPIRY);
  return null;
}
function clearSession() {
  [SS_TOKEN, SS_EXPIRY, SS_FOLDER, SS_FILE].forEach(k => sessionStorage.removeItem(k));
}

// ── Auth UI ───────────────────────────────────────────────
function updateAuthUI(signedIn) {
  const btn = document.getElementById('authBtn');
  const sts = document.getElementById('authStatus');
  if (!btn) return;
  if (signedIn) {
    btn.textContent = '🔓 Sign Out'; btn.onclick = signOut;
    if (sts) { sts.textContent = '✅ Drive connected'; sts.style.color = 'var(--green)'; }
  } else {
    btn.textContent = '🔑 Sign in'; btn.onclick = signIn;
    if (sts) { sts.textContent = '⚠️ Not signed in'; sts.style.color = 'var(--yellow)'; }
  }
}
function showStatus(msg, color) {
  const el = document.getElementById('driveStatus');
  if (el) { el.textContent = msg; if (color) el.style.color = color; }
}

// ── Google Auth ───────────────────────────────────────────
// Pending silent-refresh callers (see refreshAccessTokenSilently) — kept
// separate from the initial sign-in flow so a mid-session token refresh
// never re-triggers loadFromDrive() and clobbers unsaved local edits.
let _refreshResolvers = [];

function initGoogleAuth() {
  return new Promise((resolve) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GOOGLE_SCOPES,
      callback: async (resp) => {
        const pending = _refreshResolvers.splice(0);
        if (resp.error) {
          if (pending.length) { pending.forEach(r => r(false)); return; }
          showStatus('Auth failed'); resolve(false); return;
        }
        _accessToken = resp.access_token;
        _signedIn    = true;
        saveSession(_accessToken, resp.expires_in || 3600);
        updateAuthUI(true);
        if (pending.length) { pending.forEach(r => r(true)); return; }
        await loadFromDrive();
        resolve(true);
      },
    });
    window._gisClient = client;

    const saved = getSessionToken();
    if (saved) {
      _accessToken = saved;
      _signedIn    = true;
      _folderId    = sessionStorage.getItem(SS_FOLDER) || null;
      _fileId      = sessionStorage.getItem(SS_FILE)   || null;
      updateAuthUI(true);
      loadFromDrive().then(() => resolve(true));
    } else {
      updateAuthUI(false);
      // Not signed in — render an empty stock workspace.
      _db = emptyDb();
      _baseDb = cloneDb(_db);
      _dataReady = true;
      triggerRender();
      resolve(null);
    }
  });
}

function signIn() {
  if (!window._gisClient) { alert('Please wait and try again.'); return; }
  window._gisClient.requestAccessToken();
}
function signOut() {
  if (_unsavedChanges && !confirm('You have unsaved changes. Sign out anyway? Your changes will be lost.')) return;
  if (_accessToken) google.accounts.oauth2.revoke(_accessToken, () => {});
  _accessToken = null; _signedIn = false; _folderId = null; _fileId = null;
  clearSession();
  _db = emptyDb();
  _baseDb = cloneDb(_db);
  _loadedDriveVersion = null;
  _loadedDriveModifiedTime = null;
  updateAuthUI(false);
  triggerRender();
}

// ── Trigger page render ───────────────────────────────────
function triggerRender() {
  initProfileSelector();
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) { overlay.style.opacity='0'; setTimeout(()=>overlay.style.display='none',300); }
  if (typeof window.onDataLoaded === 'function') window.onDataLoaded();
  requestAnimationFrame(ensureActiveTableScroller);
}

// ── Floating horizontal table controls ────────────────────
let _activeTableWrap = null;
let _tableScrollControls = null;
let _tableScrollFrame = null;

function wideVisibleTableWrap() {
  return [...document.querySelectorAll('.tbl-wrap')].find(wrap => {
    const rect = wrap.getBoundingClientRect();
    return wrap.scrollWidth > wrap.clientWidth + 4 && rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  }) || null;
}

function ensureActiveTableScroller() {
  if (!_tableScrollControls) return;
  const rect = _activeTableWrap?.getBoundingClientRect();
  if (!_activeTableWrap || !_activeTableWrap.isConnected || !rect?.width) _activeTableWrap = wideVisibleTableWrap();
  updateFloatingTableScroll();
}

function scheduleFloatingTableScrollUpdate() {
  if (_tableScrollFrame) return;
  _tableScrollFrame = requestAnimationFrame(() => {
    _tableScrollFrame = null;
    updateFloatingTableScroll();
  });
}

function updateFloatingTableScroll() {
  if (!_tableScrollControls || !_activeTableWrap) return;
  const wrap = _activeTableWrap;
  const rect = wrap.getBoundingClientRect();
  const overflow = wrap.scrollWidth > wrap.clientWidth + 4;
  const visible = rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  _tableScrollControls.classList.toggle('visible', overflow && visible);
  if (!overflow || !visible) return;

  const visibleTop = Math.max(rect.top, 64);
  const visibleBottom = Math.min(rect.bottom, window.innerHeight - 16);
  const y = Math.max(72, Math.min(window.innerHeight - 48, (visibleTop + visibleBottom) / 2));
  const leftX = Math.max(10, rect.left + 10);
  const rightX = Math.min(window.innerWidth - 52, rect.right - 52);
  _tableScrollControls.style.setProperty('--table-scroll-y', `${y}px`);
  _tableScrollControls.querySelector('[data-table-scroll="left"]').style.left = `${leftX}px`;
  _tableScrollControls.querySelector('[data-table-scroll="right"]').style.left = `${rightX}px`;
  _tableScrollControls.querySelector('[data-table-scroll="left"]').disabled = wrap.scrollLeft <= 2;
  _tableScrollControls.querySelector('[data-table-scroll="right"]').disabled = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 2;
}

function initFloatingTableScroll() {
  if (_tableScrollControls) return;
  const controls = document.createElement('div');
  controls.className = 'floating-table-scroll';
  controls.setAttribute('aria-hidden', 'false');
  controls.innerHTML = `
    <button type="button" class="table-scroll-arrow" data-table-scroll="left" aria-label="Scroll table left" title="Scroll table left">←</button>
    <button type="button" class="table-scroll-arrow" data-table-scroll="right" aria-label="Scroll table right" title="Scroll table right">→</button>`;
  document.body.appendChild(controls);
  _tableScrollControls = controls;

  controls.addEventListener('click', event => {
    const button = event.target.closest('[data-table-scroll]');
    if (!button || !_activeTableWrap) return;
    const direction = button.dataset.tableScroll === 'left' ? -1 : 1;
    _activeTableWrap.scrollBy({ left: direction * Math.max(280, _activeTableWrap.clientWidth * 0.78), behavior: 'smooth' });
  });
  document.addEventListener('pointerover', event => {
    const wrap = event.target.closest?.('.tbl-wrap');
    if (wrap && wrap !== _activeTableWrap) { _activeTableWrap = wrap; updateFloatingTableScroll(); }
  });
  document.addEventListener('focusin', event => {
    const wrap = event.target.closest?.('.tbl-wrap');
    if (wrap) { _activeTableWrap = wrap; updateFloatingTableScroll(); }
  });
  document.addEventListener('click', () => requestAnimationFrame(ensureActiveTableScroller));
  document.addEventListener('scroll', scheduleFloatingTableScrollUpdate, true);
  window.addEventListener('resize', scheduleFloatingTableScrollUpdate);
  requestAnimationFrame(ensureActiveTableScroller);
}

// ── Drive helpers ─────────────────────────────────────────
// Ask Google for a fresh access token without a popup (works silently when
// the user still has an active Google session). Distinct from the initial
// sign-in flow via _refreshResolvers, so it never re-runs loadFromDrive().
function refreshAccessTokenSilently() {
  return new Promise((resolve) => {
    if (!window._gisClient) { resolve(false); return; }
    _refreshResolvers.push(resolve);
    window._gisClient.requestAccessToken({ prompt: '' });
  });
}

// Wraps fetch() so an expired access token (401) is retried once after a
// silent refresh, instead of failing the whole operation outright. The
// access token can go stale mid-session (it lasts ~1hr) while the tab stays
// open, which is the most common cause of "Save" intermittently failing.
async function driveFetch(url, options = {}) {
  const withAuth = () => ({ ...options, headers: { ...(options.headers||{}), Authorization: `Bearer ${_accessToken}` } });
  let res = await fetch(url, withAuth());
  if (res.status === 401) {
    const refreshed = await refreshAccessTokenSilently();
    if (refreshed) res = await fetch(url, withAuth());
  }
  return res;
}

async function driveGet(url) {
  const res = await driveFetch(url);
  if (!res.ok) throw new Error('Drive GET ' + res.status);
  return res.json();
}

// In-flight promises so two near-simultaneous saves (e.g. an auto-save timer
// firing right as you click Save) can't both race to create a duplicate
// folder/file before either has a chance to cache the id.
let _ensureFolderPromise = null;
async function ensureFolder() {
  if (_folderId) return _folderId;
  if (_ensureFolderPromise) return _ensureFolderPromise;
  _ensureFolderPromise = (async () => {
    const q = encodeURIComponent(`name='${DRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const r = await driveGet(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`);
    if (r.files && r.files.length > 0) {
      _folderId = r.files[0].id;
    } else {
      const res = await driveFetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: DRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
      });
      if (!res.ok) throw new Error('Drive folder create failed ' + res.status);
      _folderId = (await res.json()).id;
    }
    sessionStorage.setItem(SS_FOLDER, _folderId);
    return _folderId;
  })();
  try { return await _ensureFolderPromise; } finally { _ensureFolderPromise = null; }
}

let _ensureFilePromise = null;
async function ensureFile() {
  if (_fileId) return _fileId;
  if (_ensureFilePromise) return _ensureFilePromise;
  _ensureFilePromise = (async () => {
    const folderId = await ensureFolder();
    const q = encodeURIComponent(`name='${DATA_FILENAME}' and '${folderId}' in parents and trashed=false`);
    const r = await driveGet(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,version,modifiedTime)`);
    if (r.files && r.files.length > 0) {
      _fileId = r.files[0].id;
      _loadedDriveVersion = String(r.files[0].version || '');
      _loadedDriveModifiedTime = r.files[0].modifiedTime || null;
      sessionStorage.setItem(SS_FILE, _fileId);
    }
    return _fileId || null;
  })();
  try { return await _ensureFilePromise; } finally { _ensureFilePromise = null; }
}

async function getDriveFileMetadata(fileId = _fileId) {
  if (!fileId) return null;
  return driveGet(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,version,modifiedTime,size`);
}

// ── Load from Drive ───────────────────────────────────────
async function loadFromDrive() {
  try {
    showStatus('⏳ Loading…');
    const fileId = await ensureFile();
    if (!fileId) {
      _driveLoadFailed = false;
      showStatus('New file — save to create.', 'var(--text-muted)');
      _db = emptyDb();
      _baseDb = cloneDb(_db);
      _dataReady = true;
      triggerRender();
      return;
    }
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!res.ok) throw new Error('Download failed ' + res.status);
    const data = await res.json();
    _db = normalizeDb(data);
    _baseDb = cloneDb(_db);
    const metadata = await getDriveFileMetadata(fileId);
    _loadedDriveVersion = String(metadata?.version || '');
    _loadedDriveModifiedTime = metadata?.modifiedTime || null;
    _driveLoadFailed = false;
    _dataReady = true;
    showStatus('✅ Loaded from Drive', 'var(--green)');
    triggerRender();
  } catch(e) {
    console.error('loadFromDrive:', e);
    _driveLoadFailed = true;
    showStatus('⚠️ Load failed', 'var(--red)');
    _dataReady = true;
    triggerRender();
  }
}

async function reloadFromDriveSafely() {
  if (!_accessToken) { showStatus('⚠️ Not signed in', 'var(--yellow)'); return false; }
  if (_unsavedChanges && !confirm('Reload from Drive and discard the unsaved changes in this tab?')) return false;
  const overlay = document.getElementById('loadingOverlay');
  const msg = document.getElementById('loadingMsg');
  if (overlay) { overlay.style.display = 'flex'; overlay.style.opacity = '1'; }
  if (msg) msg.textContent = 'Refreshing from Google Drive…';
  _fileId = null;
  sessionStorage.removeItem(SS_FILE);
  await loadFromDrive();
  return !_driveLoadFailed;
}

async function uploadDriveSnapshot(name, data = _db) {
  const folderId = await ensureFolder();
  const blob = new Blob([JSON.stringify({ ...data, schema_version: DB_SCHEMA_VERSION, saved_at: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name, parents: [folderId] })], { type: 'application/json' }));
  form.append('file', blob);
  const res = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', body: form });
  if (!res.ok) throw new Error('Drive snapshot failed ' + res.status);
  return res.json();
}

// ── Save to Drive ─────────────────────────────────────────
// Serialize saves from this tab so a manual click and auto-save cannot race.
let _savePromise = null;
async function driveSave() {
  if (_savePromise) return _savePromise;
  _savePromise = performDriveSave();
  try { return await _savePromise; }
  finally { _savePromise = null; }
}

async function performDriveSave() {
  if (!_accessToken) { showStatus('⚠️ Not signed in', 'var(--yellow)'); return false; }
  if (_driveLoadFailed) {
    showStatus('⚠️ Save blocked: reload Drive data first', 'var(--red)');
    alert('Google Drive data did not load successfully. Save is blocked to avoid overwriting your Drive file with incomplete local data. Please refresh from Drive and try again.');
    return false;
  }
  try {
    showStatus('⏳ Saving to Google Drive…');
    const folderId = await ensureFolder();
    let mergedConflict = false;

    if (_fileId) {
      const metadata = await getDriveFileMetadata();
      if (_loadedDriveVersion && String(metadata?.version || '') !== _loadedDriveVersion) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        showStatus('⏳ Merging newer Drive changes…');
        const remoteRes = await driveFetch(`https://www.googleapis.com/drive/v3/files/${_fileId}?alt=media`);
        if (!remoteRes.ok) throw new Error('Conflict download failed ' + remoteRes.status);
        const remoteDb = normalizeDb(await remoteRes.json());
        await uploadDriveSnapshot(`conflict_local_${ts}.json`, _db);
        await uploadDriveSnapshot(`conflict_remote_${ts}.json`, remoteDb);
        _db = normalizeDb(StockCore.mergeDatabases(_baseDb, _db, remoteDb, DB_SCHEMA_VERSION));
        _loadedDriveVersion = String(metadata?.version || '');
        _loadedDriveModifiedTime = metadata?.modifiedTime || null;
        mergedConflict = true;
      }
      const payload = { ..._db, schema_version: DB_SCHEMA_VERSION, saved_at: new Date().toISOString() };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const res = await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${_fileId}?uploadType=media&fields=id,version,modifiedTime`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: blob,
      });
      if (!res.ok) throw new Error('Drive PATCH failed ' + res.status);
      const updated = await res.json();
      _loadedDriveVersion = String(updated.version || '');
      _loadedDriveModifiedTime = updated.modifiedTime || null;
    } else {
      const payload = { ..._db, schema_version: DB_SCHEMA_VERSION, saved_at: new Date().toISOString() };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ name: DATA_FILENAME, parents: [folderId] })], { type: 'application/json' }));
      form.append('file', blob);
      const res = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,version,modifiedTime', {
        method: 'POST', body: form,
      });
      if (!res.ok) throw new Error('Drive create failed ' + res.status);
      const created = await res.json();
      _fileId = created.id;
      _loadedDriveVersion = String(created.version || '');
      _loadedDriveModifiedTime = created.modifiedTime || null;
      sessionStorage.setItem(SS_FILE, _fileId);
    }
    _baseDb = cloneDb(_db);
    _unsavedChanges = false;
    _lastSaveTime = Date.now();
    showStatus(`${mergedConflict ? '✅ Merged and saved' : '✅ Saved to Google Drive'} — ${new Date().toLocaleTimeString()}`, 'var(--green)');
    return true;
  } catch(e) {
    console.error('driveSave:', e);
    if (String(e.message||'').includes('401')) {
      showStatus('⚠️ Session expired — please sign in again', 'var(--red)');
      alert('Your Google sign-in session expired and could not be refreshed automatically. Please click "Sign in" again, then Save.');
    } else {
      showStatus('⚠️ Save failed', 'var(--red)');
    }
    return false;
  }
}

// ── Backup (creates a named copy — user triggered only) ───
async function driveBackup() {
  if (!_accessToken) { showStatus('⚠️ Not signed in', 'var(--yellow)'); return false; }
  try {
    const saved = await driveSave(); // ensure latest saved first
    if (!saved) return false;
    const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,16);
    await uploadDriveSnapshot(`backup_${ts}.json`);
    showStatus(`✅ Backup saved: backup_${ts}.json`, 'var(--green)');
    return true;
  } catch(e) {
    showStatus('⚠️ Backup failed', 'var(--red)');
    return false;
  }
}

async function backupBeforeDestructiveAction(label) {
  if (!_signedIn) {
    alert(`Cannot ${label} safely while Drive is disconnected. Sign in and try again so a backup can be created first.`);
    return false;
  }
  showStatus('⏳ Creating safety backup…');
  const ok = await driveBackup();
  if (!ok) alert(`The safety backup failed, so ${label} was cancelled.`);
  return ok;
}

// Keep driveSync as alias (used in pages) — just save, no backup
async function driveSync(makeBackup = false) {
  if (makeBackup) return await driveBackup();
  return await driveSave();
}

// ── Public accessors ──────────────────────────────────────
function loadStockTransactions() { return _db.stock_transactions || []; }
function loadStockPrices()       { return _db.stock_prices       || []; }
function loadStockWatchlists()   { return _db.stock_watchlists   || []; }
function loadStockTrackerSymbols() { return _db.stock_tracker_symbols || []; }
function loadStockTrackerPrices()  { return _db.stock_tracker_prices  || []; }
function loadFxRates()           { return _db.fx_rates           || []; }

function saveStockTransactions(arr) { _db.stock_transactions = arr; markUnsaved(); }
function saveStockPrices(arr)       { _db.stock_prices       = arr; markUnsaved(); }
function saveStockWatchlists(arr)   { _db.stock_watchlists   = arr; markUnsaved(); }
function saveStockTrackerSymbols(arr) { _db.stock_tracker_symbols = arr; markUnsaved(); }
function saveStockTrackerPrices(arr)  { _db.stock_tracker_prices  = arr; markUnsaved(); }
function saveFxRates(arr)            { _db.fx_rates           = arr; markUnsaved(); }

// ── Excel export ──────────────────────────────────────────
function exportToExcel(sheets) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(s => { const ws = XLSX.utils.json_to_sheet(s.data); XLSX.utils.book_append_sheet(wb, ws, s.name); });
  XLSX.writeFile(wb, `StockAnalysis_${new Date().toISOString().slice(0,10)}.xlsx`);
}
function exportAllData() {
  exportToExcel([
    { name:'stock_transactions', data: loadStockTransactions() },
    { name:'stock_prices',       data: loadStockPrices() },
    { name:'stock_watchlists',   data: loadStockWatchlists() },
    { name:'stock_tracker_symbols', data: loadStockTrackerSymbols() },
    { name:'stock_tracker_prices',  data: loadStockTrackerPrices() },
    { name:'fx_rates',           data: loadFxRates() },
  ]);
}
function exportJsonBackup() {
  const blob = new Blob([JSON.stringify({..._db, exported_at: new Date().toISOString()}, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `StockAnalysis_Backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
}
function appFxToSgd(currency, date) {
  return StockCore.fxRateToSgd(currency, date, loadFxRates(), STOCK_FX_TO_SGD);
}

// stock_prices now accumulates a dated history per (profile,ticker) instead of
// one overwritten row, so weekly/monthly/YTD reference prices can be real
// snapshots instead of all being the same "previous close" value.
function latestStockPrice(profile, ticker) {
  const rows = loadStockPrices().filter(p => p.profile === profile && p.ticker === ticker);
  return rows.reduce((best, r) => (!best || String(r.asof_date||'') > String(best.asof_date||'')) ? r : best, null);
}
function stockPriceAsOf(profile, ticker, dateStr) {
  const rows = loadStockPrices().filter(p => p.profile === profile && p.ticker === ticker && String(p.asof_date||'') <= dateStr);
  return rows.reduce((best, r) => (!best || String(r.asof_date||'') > String(best.asof_date||'')) ? r : best, null);
}
function importJsonBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        const knownKeys = DATA_COLLECTION_KEYS;
        const hasKnownData = knownKeys.some(k => Array.isArray(data[k]));
        if (!hasKnownData) throw new Error('This file does not look like a Stock Analysis backup');
        const normalized = normalizeDb(data);
        if (!confirm('Import this JSON backup into the app? Review the data, then click Save to Drive if it looks right.')) return;
        if (_signedIn && !(await driveBackup())) throw new Error('Could not back up the current Drive data before import');
        _db = normalized;
        _driveLoadFailed = false;
        _dataReady = true;
        markUnsaved();
        showStatus('JSON imported — review, then save to Drive', 'var(--yellow)');
        triggerRender();
      } catch (e) {
        console.error('importJsonBackup:', e);
        alert('Could not import this JSON backup. Please choose a valid Stock Analysis JSON file.');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}
// ── UUID & constants ──────────────────────────────────────
function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16);
  });
}
// ── Auto-save & unsaved change tracking ──────────────────
let _unsavedChanges = false;
let _lastSaveTime   = Date.now();
let _autoSaveTimer  = null;
const AUTO_SAVE_INTERVAL = 10 * 60 * 1000; // 10 minutes

function markUnsaved() {
  _unsavedChanges = true;
  // Reset auto-save countdown from last change
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(async () => {
    if (_unsavedChanges && _signedIn) {
      showStatus('⏳ Auto-saving…');
      await driveSave();
    }
  }, AUTO_SAVE_INTERVAL);
  // Update status indicator
  showStatus('● Unsaved changes', 'var(--yellow)');
}

// Warn before tab/browser close if unsaved
window.addEventListener('beforeunload', (e) => {
  if (_unsavedChanges) {
    e.preventDefault();
    e.returnValue = 'You have unsaved changes. Save to Google Drive before leaving?';
    return e.returnValue;
  }
});

// ── Boot ──────────────────────────────────────────────────
window.addEventListener('load', async () => {
  initFloatingTableScroll();
  updateAuthUI(false);
  await initGoogleAuth();
});
