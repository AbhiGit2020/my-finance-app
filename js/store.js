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

let _db          = emptyDb();
let _accessToken = null;
let _folderId    = null;
let _fileId      = null;
let _signedIn    = false;
let _dataReady   = false;

// ── Empty DB ──────────────────────────────────────────────
function emptyDb() {
  return {
    finance_records:[], finance_categories:[], useless_expenses:[],
    stock_transactions:[], stock_prices:[], assets_master:[],
    asset_values:[], investment_data:[],
  };
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
    if (sts) { sts.textContent = '✅ Connected to Google Drive'; sts.style.color = 'var(--green)'; }
  } else {
    btn.textContent = '🔑 Sign in with Google'; btn.onclick = signIn;
    if (sts) { sts.textContent = '⚠️ Sign in to sync data'; sts.style.color = 'var(--yellow)'; }
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
    _dataReady = true;
    showStatus('✅ Loaded from Drive', 'var(--green)');
    triggerRender();
  } catch(e) {
    console.error('loadFromDrive:', e);
    showStatus('⚠️ Load failed', 'var(--red)');
    _dataReady = true;
    triggerRender();
  }
}

// ── Save to Drive (overwrite only) ────────────────────────
async function driveSave() {
  if (!_accessToken) { showStatus('⚠️ Not signed in', 'var(--yellow)'); return false; }
  try {
    showStatus('⏳ Saving to Google Drive…');
    const blob = new Blob([JSON.stringify({ ..._db, saved_at: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const folderId = await ensureFolder();

    if (_fileId) {
      await fetch(`https://www.googleapis.com/upload/drive/v3/files/${_fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${_accessToken}`, 'Content-Type': 'application/json' },
        body: blob,
      });
    } else {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ name: DATA_FILENAME, parents: [folderId] })], { type: 'application/json' }));
      form.append('file', blob);
      const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST', headers: { Authorization: `Bearer ${_accessToken}` }, body: form,
      });
      _fileId = (await res.json()).id;
      sessionStorage.setItem(SS_FILE, _fileId);
    }
    showStatus(`✅ Saved to Google Drive — ${new Date().toLocaleTimeString()}`, 'var(--green)');
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
    await driveSave(); // ensure latest saved first
    const folderId = await ensureFolder();
    const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,16);
    const blob = new Blob([JSON.stringify({ ..._db, saved_at: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name: `backup_${ts}.json`, parents: [folderId] })], { type: 'application/json' }));
    form.append('file', blob);
    await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST', headers: { Authorization: `Bearer ${_accessToken}` }, body: form,
    });
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
function loadAssetsMaster()      { return _db.assets_master      || []; }
function loadAssetValues()       { return _db.asset_values       || []; }
function loadInvestmentData()    { return _db.investment_data    || []; }

function saveFinanceRecords(arr)    { _db.finance_records    = arr; }
function saveCategories(arr)        { _db.finance_categories = arr; }
function saveUselessExpenses(arr)   { _db.useless_expenses   = arr; }
function saveStockTransactions(arr) { _db.stock_transactions = arr; }
function saveStockPrices(arr)       { _db.stock_prices       = arr; }
function saveAssetsMaster(arr)      { _db.assets_master      = arr; }
function saveAssetValues(arr)       { _db.asset_values       = arr; }
function saveInvestmentData(arr)    { _db.investment_data    = arr; }

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
  add('outgoing','Investments','investment','Manulife Regular Insurance Plan',1);
  add('outgoing','Investments','investment','Manulife Ready Builder 10',2);
  add('outgoing','Investments','investment','Manulife Ready - 8',3);
  add('outgoing','Investments','investment','DBS STI Unit Trust',4);
  add('outgoing','Investments','investment','SYFE Equity 100 - ABHI',5);
  add('outgoing','Investments','investment','SYFE Equities 100 - KIARA',6);
  add('outgoing','Investments','investment','SYFE SG Stocks',7);
  add('outgoing','Investments','investment','IBKR Equities - ABHI',8);
  add('outgoing','Investments','investment','IBKR Equities - KIARA',9);
  add('outgoing','Investments','investment','SRS Endowus',10);
  add('outgoing','Investments','investment','SYFE REITS',11);
  _db.finance_categories = rows;
  return rows;
}

// ── Boot ──────────────────────────────────────────────────
window.addEventListener('load', async () => {
  updateAuthUI(false);
  await initGoogleAuth();
});
