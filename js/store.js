// ============================================================
// store.js — Google Drive as single source of truth
// v3 — Drive always primary, Save = overwrite, Backup = manual
// ============================================================

const GOOGLE_CLIENT_ID = '356564967624-454aiiodg41u0l1ialidtmhlpj8erdtp.apps.googleusercontent.com';
const GOOGLE_SCOPES    = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER     = 'MyFinanceApp';
const DATA_FILENAME    = 'data.json';

const SS_TOKEN  = 'hf_gtoken';
const SS_EXPIRY = 'hf_gtoken_exp';
const SS_FOLDER = 'hf_gfolder';
const SS_FILE   = 'hf_gfile';
const STOCK_FX_TO_SGD = { SGD:1, USD:1.35, EUR:1.46, INR:0.0161, GBP:1.72, HKD:0.173, AUD:0.91 };

let _db          = emptyDb();
let _accessToken = null;
let _folderId    = null;
let _fileId      = null;
let _signedIn    = false;
let _dataReady   = false;
let _driveLoadFailed = false;

// ── Empty DB ──────────────────────────────────────────────
function emptyDb() {
  return {
    finance_records:[], finance_categories:[], useless_expenses:[],
    stock_transactions:[], stock_prices:[], stock_watchlists:[],
    stock_tracker_symbols:[], stock_tracker_prices:[], assets_master:[],
    asset_values:[], investment_data:[],
  };
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
function initGoogleAuth() {
  return new Promise((resolve) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GOOGLE_SCOPES,
      callback: async (resp) => {
        if (resp.error) { showStatus('Auth failed'); resolve(false); return; }
        _accessToken = resp.access_token;
        _signedIn    = true;
        saveSession(_accessToken, resp.expires_in || 3600);
        updateAuthUI(true);
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
      // Not signed in — render with empty/seed data
      _db = emptyDb();
      _db.finance_categories = seedCategories(2024);
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
  _db.finance_categories = seedCategories(2024);
  updateAuthUI(false);
  triggerRender();
}

// ── Trigger page render ───────────────────────────────────
function triggerRender() {
  initProfileSelector();
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) { overlay.style.opacity='0'; setTimeout(()=>overlay.style.display='none',300); }
  if (typeof window.onDataLoaded === 'function') window.onDataLoaded();
}

// ── Drive helpers ─────────────────────────────────────────
async function driveGet(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${_accessToken}` } });
  if (!res.ok) throw new Error('Drive GET ' + res.status);
  return res.json();
}

async function ensureFolder() {
  if (_folderId) return _folderId;
  const q = encodeURIComponent(`name='${DRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const r = await driveGet(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`);
  if (r.files && r.files.length > 0) {
    _folderId = r.files[0].id;
  } else {
    const res = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${_accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: DRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
    });
    _folderId = (await res.json()).id;
  }
  sessionStorage.setItem(SS_FOLDER, _folderId);
  return _folderId;
}

async function ensureFile() {
  if (_fileId) return _fileId;
  const folderId = await ensureFolder();
  const q = encodeURIComponent(`name='${DATA_FILENAME}' and '${folderId}' in parents and trashed=false`);
  const r = await driveGet(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`);
  if (r.files && r.files.length > 0) {
    _fileId = r.files[0].id;
    sessionStorage.setItem(SS_FILE, _fileId);
  }
  return _fileId || null;
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
      _db.finance_categories = seedCategories(2024);
      _dataReady = true;
      triggerRender();
      return;
    }
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${_accessToken}` }
    });
    if (!res.ok) throw new Error('Download failed ' + res.status);
    const data = await res.json();
    _db = { ...emptyDb(), ...data };
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

// ── Save to Drive (overwrite only) ────────────────────────
async function driveSave() {
  if (!_accessToken) { showStatus('⚠️ Not signed in', 'var(--yellow)'); return false; }
  if (_driveLoadFailed) {
    showStatus('⚠️ Save blocked: reload Drive data first', 'var(--red)');
    alert('Google Drive data did not load successfully. Save is blocked to avoid overwriting your Drive file with incomplete local data. Please refresh from Drive and try again.');
    return false;
  }
  try {
    showStatus('⏳ Saving to Google Drive…');
    const blob = new Blob([JSON.stringify({ ..._db, saved_at: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const folderId = await ensureFolder();

    if (_fileId) {
      const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${_fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${_accessToken}`, 'Content-Type': 'application/json' },
        body: blob,
      });
      if (!res.ok) throw new Error('Drive PATCH failed ' + res.status);
    } else {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ name: DATA_FILENAME, parents: [folderId] })], { type: 'application/json' }));
      form.append('file', blob);
      const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST', headers: { Authorization: `Bearer ${_accessToken}` }, body: form,
      });
      if (!res.ok) throw new Error('Drive create failed ' + res.status);
      _fileId = (await res.json()).id;
      sessionStorage.setItem(SS_FILE, _fileId);
    }
    _unsavedChanges = false; _lastSaveTime = Date.now(); showStatus(`✅ Saved to Google Drive — ${new Date().toLocaleTimeString()}`, 'var(--green)');
    return true;
  } catch(e) {
    console.error('driveSave:', e);
    showStatus('⚠️ Save failed', 'var(--red)');
    return false;
  }
}

// ── Backup (creates a named copy — user triggered only) ───
async function driveBackup() {
  if (!_accessToken) { showStatus('⚠️ Not signed in', 'var(--yellow)'); return false; }
  try {
    const saved = await driveSave(); // ensure latest saved first
    if (!saved) return false;
    const folderId = await ensureFolder();
    const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,16);
    const blob = new Blob([JSON.stringify({ ..._db, saved_at: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name: `backup_${ts}.json`, parents: [folderId] })], { type: 'application/json' }));
    form.append('file', blob);
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST', headers: { Authorization: `Bearer ${_accessToken}` }, body: form,
    });
    if (!res.ok) throw new Error('Drive backup failed ' + res.status);
    showStatus(`✅ Backup saved: backup_${ts}.json`, 'var(--green)');
    return true;
  } catch(e) {
    showStatus('⚠️ Backup failed', 'var(--red)');
    return false;
  }
}

// Keep driveSync as alias (used in pages) — just save, no backup
async function driveSync(makeBackup = false) {
  if (makeBackup) return await driveBackup();
  return await driveSave();
}

// ── Public accessors ──────────────────────────────────────
function loadFinanceRecords()    { return _db.finance_records    || []; }
function loadCategories()        { return (_db.finance_categories && _db.finance_categories.length) ? _db.finance_categories : seedCategories(2024); }
function loadUselessExpenses()   { return _db.useless_expenses   || []; }
function loadStockTransactions() { return _db.stock_transactions || []; }
function loadStockPrices()       { return _db.stock_prices       || []; }
function loadStockWatchlists()   { return _db.stock_watchlists   || []; }
function loadStockTrackerSymbols() { return _db.stock_tracker_symbols || []; }
function loadStockTrackerPrices()  { return _db.stock_tracker_prices  || []; }
function loadAssetsMaster()      { return _db.assets_master      || []; }
function loadAssetValues()       { return _db.asset_values       || []; }
function loadInvestmentData()    { return _db.investment_data    || []; }

function saveFinanceRecords(arr)    { _db.finance_records    = arr; markUnsaved(); }
function getProfileRecords() { return (_db.finance_records||[]).filter(r=>r.profile===getActiveProfile()||!r.profile); }
function saveCategories(arr)        { _db.finance_categories = arr; markUnsaved(); }
function saveUselessExpenses(arr)   { _db.useless_expenses   = arr; }
function saveStockTransactions(arr) { _db.stock_transactions = arr; markUnsaved(); }
function saveStockPrices(arr)       { _db.stock_prices       = arr; markUnsaved(); }
function saveStockWatchlists(arr)   { _db.stock_watchlists   = arr; markUnsaved(); }
function saveStockTrackerSymbols(arr) { _db.stock_tracker_symbols = arr; markUnsaved(); }
function saveStockTrackerPrices(arr)  { _db.stock_tracker_prices  = arr; markUnsaved(); }
function saveAssetsMaster(arr)      { _db.assets_master      = arr; markUnsaved(); }
function saveAssetValues(arr)       { _db.asset_values       = arr; markUnsaved(); }
function saveInvestmentData(arr)    { _db.investment_data    = arr; markUnsaved(); }

// ── Excel export ──────────────────────────────────────────
function exportToExcel(sheets) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(s => { const ws = XLSX.utils.json_to_sheet(s.data); XLSX.utils.book_append_sheet(wb, ws, s.name); });
  XLSX.writeFile(wb, `MyFinance_${new Date().toISOString().slice(0,10)}.xlsx`);
}
function exportAllData() {
  exportToExcel([
    { name:'finance_records',    data: loadFinanceRecords() },
    { name:'finance_categories', data: loadCategories() },
    { name:'useless_expenses',   data: loadUselessExpenses() },
    { name:'stock_transactions', data: loadStockTransactions() },
    { name:'stock_prices',       data: loadStockPrices() },
    { name:'stock_watchlists',   data: loadStockWatchlists() },
    { name:'stock_tracker_symbols', data: loadStockTrackerSymbols() },
    { name:'stock_tracker_prices',  data: loadStockTrackerPrices() },
    { name:'assets_master',      data: loadAssetsMaster() },
    { name:'asset_values',       data: loadAssetValues() },
    { name:'investment_data',    data: loadInvestmentData() },
  ]);
}
function exportJsonBackup() {
  const blob = new Blob([JSON.stringify({..._db, exported_at: new Date().toISOString()}, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `MyFinance_Backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
}
function appStockFxToSgd(currency) {
  return STOCK_FX_TO_SGD[String(currency || 'SGD').toUpperCase()] || 1;
}
function importJsonBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid JSON backup');
        const knownKeys = Object.keys(emptyDb());
        const hasKnownData = knownKeys.some(k => Array.isArray(data[k]));
        if (!hasKnownData) throw new Error('This file does not look like a MyFinance backup');
        if (!confirm('Import this JSON backup into the app? Review the data, then click Save to Drive if it looks right.')) return;
        _db = { ...emptyDb(), ...data };
        if (!(_db.finance_categories && _db.finance_categories.length)) _db.finance_categories = seedCategories(2024);
        _driveLoadFailed = false;
        _dataReady = true;
        markUnsaved();
        showStatus('JSON imported — review, then save to Drive', 'var(--yellow)');
        triggerRender();
      } catch (e) {
        console.error('importJsonBackup:', e);
        alert('Could not import this JSON backup. Please choose a valid MyFinance JSON file.');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}
function appHealthSnapshot() {
  const db = { ...emptyDb(), ..._db };
  const profiles = PROFILES;
  const stockTx = db.stock_transactions || [];
  const stockPrices = db.stock_prices || [];
  const openHoldings = [];
  profiles.forEach(profile => {
    const positions = {};
    stockTx.filter(t => t.profile === profile).sort((a,b)=>new Date(a.date)-new Date(b.date)).forEach(t => {
      const ticker = String(t.ticker || '').toUpperCase();
      if (!ticker) return;
      if (!positions[ticker]) positions[ticker] = { qty:0 };
      const qty = parseFloat(t.qty) || 0;
      if (t.action === 'BUY') positions[ticker].qty += qty;
      else positions[ticker].qty -= qty;
    });
    Object.entries(positions).forEach(([ticker,pos]) => {
      if (pos.qty > 0.0001) openHoldings.push({ profile, ticker });
    });
  });
  const priceKeys = new Set(stockPrices.map(p => `${p.profile || 'Abhi'}|${String(p.ticker || '').toUpperCase()}`));
  const missingStockPrices = openHoldings.filter(h => !priceKeys.has(`${h.profile}|${h.ticker}`));
  const tracked = (db.stock_tracker_symbols || []).filter(s => s.active !== false);
  const trackerPrices = db.stock_tracker_prices || [];
  const baselineKeys = new Set(trackerPrices.filter(p => p.asof_date === '2025-01-01' && parseFloat(p.close) > 0).map(p => `${p.profile || 'Abhi'}|${String(p.symbol || '').toUpperCase()}`));
  const trackedKeys = [...new Map(tracked.map(s => [`${s.profile || 'Abhi'}|${String(s.symbol || '').toUpperCase()}`, s])).values()];
  const missingCompareBaselines = trackedKeys.filter(s => !baselineKeys.has(`${s.profile || 'Abhi'}|${String(s.symbol || '').toUpperCase()}`));
  return {
    signedIn:_signedIn,
    unsaved:_unsavedChanges,
    driveLoadFailed:_driveLoadFailed,
    lastSaveTime:_lastSaveTime,
    counts:{
      finance_records:db.finance_records.length,
      investment_data:db.investment_data.length,
      stock_transactions:db.stock_transactions.length,
      stock_prices:db.stock_prices.length,
      tracked_symbols:tracked.length,
      assets:db.assets_master.length + db.asset_values.length,
    },
    missingStockPrices,
    missingCompareBaselines,
  };
}

// ── UUID & constants ──────────────────────────────────────
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16);
  });
}
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Seed categories ───────────────────────────────────────
function seedCategories(year = 2024) {
  const rows = [];
  const add = (section, group, type, category, order) =>
    rows.push({ category_id:uuid(), section, group, type, category, order, active:true, start_year:year-2, end_year:null, notes:'' });
  add('incoming','Primary','income','Salary',1);
  add('incoming','Primary','income','Dividends',2);
  add('incoming','Primary','income','Reimbursements',3);
  add('incoming','Primary','income','Others',4);
  add('outgoing','Living','expense','Mortgage',1);
  add('outgoing','Living','expense','Child Care / School Fees',2);
  add('outgoing','Living','expense','Credit Card Bill - 3 SC Cash',3);
  add('outgoing','Living','expense','Small / Daily Expenses',4);
  add('outgoing','Living','expense','Big Ticket Purchases',5);
  add('outgoing','Insurance','expense','Insurance - 1',1);
  add('outgoing','Insurance','expense','Insurance - 2',2);
  add('outgoing','Taxes','tax','Income Tax',1);
  add('outgoing','Taxes','tax','Personal Tax',2);
  _db.finance_categories = rows;
  return rows;
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
      _unsavedChanges = false;
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
  updateAuthUI(false);
  await initGoogleAuth();
});
