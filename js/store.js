// ============================================================
// store.js — Google Drive as single source of truth
// ============================================================

const GOOGLE_CLIENT_ID = '356564967624-454aiiodg41u0l1ialidtmhlpj8erdtp.apps.googleusercontent.com';
const GOOGLE_SCOPES    = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER     = 'MyFinanceApp';
const DATA_FILENAME    = 'data.json';

// Session keys
const SS_TOKEN  = 'hf_gtoken';
const SS_EXPIRY = 'hf_gtoken_exp';
const SS_FOLDER = 'hf_gfolder';
const SS_FILE   = 'hf_gfile';

// In-memory DB
let _db = emptyDb();
let _accessToken = null;
let _folderId    = null;
let _fileId      = null;
let _signedIn    = false;

// ── Empty DB ──────────────────────────────────────────────
function emptyDb() {
  return {
    finance_records:[], finance_categories:[], useless_expenses:[],
    stock_transactions:[], stock_prices:[], assets_master:[],
    asset_values:[], investment_data:[],
  };
}

function hasData(db) {
  return db && Object.values(db).some(v => Array.isArray(v) && v.length > 0);
}

// ── Session token ─────────────────────────────────────────
function saveSession(token, expiresIn) {
  const exp = Date.now() + (expiresIn - 60) * 1000;
  sessionStorage.setItem(SS_TOKEN, token);
  sessionStorage.setItem(SS_EXPIRY, exp.toString());
}

function getSessionToken() {
  const token = sessionStorage.getItem(SS_TOKEN);
  const exp   = parseInt(sessionStorage.getItem(SS_EXPIRY) || '0');
  if (token && Date.now() < exp) return token;
  sessionStorage.removeItem(SS_TOKEN);
  sessionStorage.removeItem(SS_EXPIRY);
  return null;
}

function clearSession() {
  [SS_TOKEN, SS_EXPIRY, SS_FOLDER, SS_FILE].forEach(k => sessionStorage.removeItem(k));
}

// ── Auth UI ───────────────────────────────────────────────
function updateAuthUI(signedIn) {
  const btn    = document.getElementById('authBtn');
  const status = document.getElementById('authStatus');
  const dstatus= document.getElementById('driveStatus');
  if (!btn) return;
  if (signedIn) {
    btn.textContent = '🔓 Sign Out'; btn.onclick = signOut;
    if (status) { status.textContent = '✅ Connected to Google Drive'; status.style.color = 'var(--green)'; }
  } else {
    btn.textContent = '🔑 Sign in with Google'; btn.onclick = signIn;
    if (status) { status.textContent = '⚠️ Sign in to sync data'; status.style.color = 'var(--yellow)'; }
    if (dstatus) dstatus.textContent = '';
  }
}

function showStatus(msg, color) {
  const el = document.getElementById('driveStatus');
  if (el) { el.textContent = msg; if(color) el.style.color = color; }
  console.log('[Drive]', msg);
}

// ── Google Auth ───────────────────────────────────────────
function initGoogleAuth() {
  return new Promise((resolve) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GOOGLE_SCOPES,
      callback: async (resp) => {
        if (resp.error) { showStatus('Auth failed: ' + resp.error); resolve(false); return; }
        _accessToken = resp.access_token;
        _signedIn = true;
        saveSession(_accessToken, resp.expires_in || 3600);
        updateAuthUI(true);
        await loadFromDrive();
        resolve(true);
      },
    });
    window._gisClient = client;

    // Restore from session on page navigation
    const saved = getSessionToken();
    if (saved) {
      _accessToken = saved;
      _signedIn    = true;
      _folderId    = sessionStorage.getItem(SS_FOLDER) || null;
      _fileId      = sessionStorage.getItem(SS_FILE)   || null;
      updateAuthUI(true);
      showStatus('Restoring session…');
      loadFromDrive().then(() => resolve(true));
    } else {
      updateAuthUI(false);
      resolve(null);
    }
  });
}

function signIn() {
  if (!window._gisClient) { alert('Please wait a moment and try again.'); return; }
  window._gisClient.requestAccessToken();
}

function signOut() {
  if (_accessToken) google.accounts.oauth2.revoke(_accessToken, () => {});
  _accessToken = null; _signedIn = false; _folderId = null; _fileId = null;
  clearSession();
  _db = emptyDb();
  updateAuthUI(false);
  if (typeof window.onDataLoaded === 'function') window.onDataLoaded();
}

// ── Drive API ─────────────────────────────────────────────
async function driveGet(url) {
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${_accessToken}` } });
  if (!res.ok) throw new Error(`Drive GET ${res.status}`);
  return res.json();
}

async function drivePost(url, body, method='POST') {
  const res = await fetch(url, {
    method, headers: { 'Authorization': `Bearer ${_accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Drive POST ${res.status}`);
  return res.json();
}

async function ensureFolder() {
  if (_folderId) return _folderId;
  const q = `name='${DRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r = await driveGet(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`);
  if (r.files && r.files.length > 0) {
    _folderId = r.files[0].id;
  } else {
    const f = await drivePost('https://www.googleapis.com/drive/v3/files', { name: DRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder' });
    _folderId = f.id;
  }
  sessionStorage.setItem(SS_FOLDER, _folderId);
  return _folderId;
}

async function findFile() {
  if (_fileId) return _fileId;
  const folderId = await ensureFolder();
  const q = `name='${DATA_FILENAME}' and '${folderId}' in parents and trashed=false`;
  const r = await driveGet(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,modifiedTime)`);
  if (r.files && r.files.length > 0) {
    _fileId = r.files[0].id;
    sessionStorage.setItem(SS_FILE, _fileId);
  }
  return _fileId || null;
}

// ── Load from Drive (always on sign-in / page restore) ────
async function loadFromDrive() {
  try {
    showStatus('⏳ Loading from Google Drive…');
    const fileId = await findFile();

    if (!fileId) {
      showStatus('No Drive data yet — will create on first save.');
      _db = emptyDb();
      _db.finance_categories = seedCategories(2024);
      if (typeof window.onDataLoaded === 'function') window.onDataLoaded();
      return;
    }

    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { 'Authorization': `Bearer ${_accessToken}` }
    });
    if (!res.ok) throw new Error('Download failed ' + res.status);
    const data = await res.json();
    _db = { ...emptyDb(), ...data };
    showStatus(`✅ Data loaded from Drive`, 'var(--green)');
    if (typeof window.onDataLoaded === 'function') window.onDataLoaded();
  } catch(e) {
    console.error('loadFromDrive:', e);
    showStatus('⚠️ Could not load from Drive.', 'var(--yellow)');
  }
}

// ── Save to Drive ─────────────────────────────────────────
async function saveToDrive(makeBackup = false) {
  if (!_accessToken) {
    showStatus('⚠️ Not signed in — data not saved to Drive.', 'var(--yellow)');
    return false;
  }
  try {
    showStatus('⏳ Saving to Drive…');
    const content = JSON.stringify({ ..._db, saved_at: new Date().toISOString() }, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const folderId = await ensureFolder();

    if (_fileId) {
      // Update existing
      await fetch(`https://www.googleapis.com/upload/drive/v3/files/${_fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${_accessToken}`, 'Content-Type': 'application/json' },
        body: blob,
      });
    } else {
      // Create new
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ name: DATA_FILENAME, parents: [folderId] })], { type: 'application/json' }));
      form.append('file', blob);
      const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST', headers: { 'Authorization': `Bearer ${_accessToken}` }, body: form,
      });
      const file = await res.json();
      _fileId = file.id;
      sessionStorage.setItem(SS_FILE, _fileId);
    }

    // Optional backup copy
    if (makeBackup) {
      const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ name: `backup_${ts}.json`, parents: [folderId] })], { type: 'application/json' }));
      form.append('file', blob);
      await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST', headers: { 'Authorization': `Bearer ${_accessToken}` }, body: form,
      });
      showStatus(`✅ Saved + backup created — ${new Date().toLocaleTimeString()}`, 'var(--green)');
    } else {
      showStatus(`✅ Saved to Drive — ${new Date().toLocaleTimeString()}`, 'var(--green)');
    }
    return true;
  } catch(e) {
    console.error('saveToDrive:', e);
    showStatus('⚠️ Drive save failed.', 'var(--red)');
    return false;
  }
}

async function driveSync(makeBackup = false) { return await saveToDrive(makeBackup); }

// ── Public accessors ──────────────────────────────────────
function loadFinanceRecords()    { return _db.finance_records    || []; }
function loadCategories()        { return _db.finance_categories && _db.finance_categories.length ? _db.finance_categories : seedCategories(2024); }
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
  // If not signed in, still render with empty data
  if (!_signedIn && typeof window.onDataLoaded === 'function') {
    window.onDataLoaded();
  }
});
