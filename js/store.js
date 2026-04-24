// ============================================================
// store.js — Data layer with Google Drive sync
// ============================================================

const GOOGLE_CLIENT_ID = '356564967624-454aiiodg41u0l1ialidtmhlpj8erdtp.apps.googleusercontent.com';
const GOOGLE_SCOPES    = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER     = 'MyFinanceApp';
const DATA_FILENAME    = 'data.json';

// ── In-memory data store ──────────────────────────────────
let _db = {
  finance_records:    [],
  finance_categories: [],
  useless_expenses:   [],
  stock_transactions: [],
  stock_prices:       [],
  assets_master:      [],
  asset_values:       [],
  investment_data:    [],
};

let _accessToken  = null;
let _folderId     = null;
let _fileId       = null;
let _initialized  = false;
let _signedIn     = false;

// ── Session token persistence ─────────────────────────────
const SS_TOKEN  = 'hf_gtoken';
const SS_EXPIRY = 'hf_gtoken_exp';
const SS_FOLDER = 'hf_gfolder';
const SS_FILE   = 'hf_gfile';

function saveTokenToSession(token, expiresIn = 3600) {
  const expiry = Date.now() + (expiresIn - 60) * 1000; // 1 min buffer
  sessionStorage.setItem(SS_TOKEN,  token);
  sessionStorage.setItem(SS_EXPIRY, expiry.toString());
}

function loadTokenFromSession() {
  const token  = sessionStorage.getItem(SS_TOKEN);
  const expiry = parseInt(sessionStorage.getItem(SS_EXPIRY) || '0');
  if (token && Date.now() < expiry) return token;
  sessionStorage.removeItem(SS_TOKEN);
  sessionStorage.removeItem(SS_EXPIRY);
  return null;
}

function clearSession() {
  sessionStorage.removeItem(SS_TOKEN);
  sessionStorage.removeItem(SS_EXPIRY);
  sessionStorage.removeItem(SS_FOLDER);
  sessionStorage.removeItem(SS_FILE);
}

// ── Google Identity Services ──────────────────────────────
function initGoogleAuth() {
  return new Promise((resolve) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GOOGLE_SCOPES,
      callback: async (response) => {
        if (response.error) { console.error('Auth error:', response.error); resolve(false); return; }
        _accessToken = response.access_token;
        _signedIn = true;
        saveTokenToSession(_accessToken, response.expires_in || 3600);
        updateAuthUI(true);
        await loadFromDrive();
        resolve(true);
      },
    });
    window._gisClient = client;

    // Try to restore token from session (user navigated between pages)
    const savedToken = loadTokenFromSession();
    if (savedToken) {
      _accessToken = savedToken;
      _signedIn = true;
      _folderId = sessionStorage.getItem(SS_FOLDER) || null;
      _fileId   = sessionStorage.getItem(SS_FILE)   || null;
      updateAuthUI(true);
      loadFromDrive().then(() => resolve(true));
    } else {
      resolve(null);
    }
  });
}

function signIn() {
  if (!window._gisClient) { alert('Google auth not ready yet. Please wait a moment and try again.'); return; }
  window._gisClient.requestAccessToken();
}

function signOut() {
  if (_accessToken) google.accounts.oauth2.revoke(_accessToken, () => {});
  _accessToken = null; _signedIn = false; _folderId = null; _fileId = null; _initialized = false;
  clearSession();
  updateAuthUI(false);
}

function updateAuthUI(signedIn) {
  const btn = document.getElementById('authBtn');
  const status = document.getElementById('authStatus');
  if (!btn) return;
  if (signedIn) {
    btn.textContent = '🔓 Sign Out'; btn.onclick = signOut;
    if (status) { status.textContent = '✅ Connected to Google Drive'; status.style.color = 'var(--green)'; }
  } else {
    btn.textContent = '🔑 Sign in with Google'; btn.onclick = signIn;
    if (status) { status.textContent = '⚠️ Not signed in — data saved locally only'; status.style.color = 'var(--yellow)'; }
  }
}

// ── Drive API helpers ─────────────────────────────────────
async function driveRequest(url, options = {}) {
  if (!_accessToken) throw new Error('Not authenticated');
  const res = await fetch(url, { ...options, headers: { 'Authorization': `Bearer ${_accessToken}`, ...(options.headers || {}) } });
  if (!res.ok) throw new Error(`Drive API error ${res.status}`);
  return res.json();
}

async function findOrCreateFolder() {
  const search = await driveRequest(`https://www.googleapis.com/drive/v3/files?q=name='${DRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`);
  if (search.files && search.files.length > 0) { _folderId = search.files[0].id; sessionStorage.setItem(SS_FOLDER, _folderId); return _folderId; }
  const folder = await driveRequest('https://www.googleapis.com/drive/v3/files', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
  });
  _folderId = folder.id;
  sessionStorage.setItem(SS_FOLDER, _folderId);
  return _folderId;
}

async function findDataFile() {
  await findOrCreateFolder();
  const search = await driveRequest(`https://www.googleapis.com/drive/v3/files?q=name='${DATA_FILENAME}' and '${_folderId}' in parents and trashed=false&fields=files(id,name,modifiedTime)`);
  if (search.files && search.files.length > 0) { _fileId = search.files[0].id; sessionStorage.setItem(SS_FILE, _fileId); return _fileId; }
  return null;
}

async function loadFromDrive() {
  try {
    showDriveStatus('Loading data from Google Drive…');
    const fileId = await findDataFile();
    if (!fileId) {
      const localData = loadFromLocalStorage();
      if (hasData(localData)) { _db = localData; showDriveStatus('Local data found. Save to push to Drive.'); }
      else { _db = emptyDb(); _db.finance_categories = seedCategories(2024); showDriveStatus('Ready. No existing data found.'); }
      _initialized = true;
      if (typeof window.onDataLoaded === 'function') window.onDataLoaded();
      return;
    }
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { 'Authorization': `Bearer ${_accessToken}` } });
    const data = await res.json();
    _db = { ...emptyDb(), ...data };
    _initialized = true;
    showDriveStatus(`✅ Data loaded from Google Drive`);
    if (typeof window.onDataLoaded === 'function') window.onDataLoaded();
  } catch(e) {
    console.error('loadFromDrive error:', e);
    showDriveStatus('⚠️ Could not load from Drive. Using local data.');
    _db = loadFromLocalStorage();
    _initialized = true;
    if (typeof window.onDataLoaded === 'function') window.onDataLoaded();
  }
}

async function saveToDrive(makeBackup = false) {
  if (!_accessToken) { saveToLocalStorage(); return false; }
  try {
    const content = JSON.stringify({ ..._db, saved_at: new Date().toISOString() }, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    if (!_folderId) await findOrCreateFolder();
    if (_fileId) {
      await fetch(`https://www.googleapis.com/upload/drive/v3/files/${_fileId}?uploadType=media`, {
        method: 'PATCH', headers: { 'Authorization': `Bearer ${_accessToken}`, 'Content-Type': 'application/json' }, body: blob,
      });
    } else {
      const metadata = { name: DATA_FILENAME, parents: [_folderId] };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', blob);
      const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST', headers: { 'Authorization': `Bearer ${_accessToken}` }, body: form,
      });
      const file = await res.json();
      _fileId = file.id;
      sessionStorage.setItem(SS_FILE, _fileId);
    }
    if (makeBackup) {
      const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ name: `backup_${ts}.json`, parents: [_folderId] })], { type: 'application/json' }));
      form.append('file', blob);
      await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST', headers: { 'Authorization': `Bearer ${_accessToken}` }, body: form,
      });
      showDriveStatus(`✅ Saved + backup created — ${new Date().toLocaleTimeString()}`);
    } else {
      showDriveStatus(`✅ Saved to Google Drive — ${new Date().toLocaleTimeString()}`);
    }
    saveToLocalStorage();
    return true;
  } catch(e) {
    console.error('saveToDrive error:', e);
    showDriveStatus('⚠️ Drive save failed. Saved locally only.');
    saveToLocalStorage();
    return false;
  }
}

async function driveSync(makeBackup = false) { return await saveToDrive(makeBackup); }

function showDriveStatus(msg) {
  const el = document.getElementById('driveStatus');
  if (el) el.textContent = msg;
  console.log('[Drive]', msg);
}

// ── localStorage fallback ─────────────────────────────────
const LS_KEY = 'hf_db_v2';
function saveToLocalStorage() { try { localStorage.setItem(LS_KEY, JSON.stringify(_db)); } catch(e) {} }
function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...emptyDb(), ...JSON.parse(raw) };
    const get = (k) => { try { const r=localStorage.getItem(k); return r?JSON.parse(r):[]; } catch(e){return [];} };
    return {
      finance_records: get('hf_finance_records'), finance_categories: get('hf_finance_categories'),
      useless_expenses: get('hf_useless_expenses'), stock_transactions: get('hf_stock_transactions'),
      stock_prices: get('hf_stock_prices'), assets_master: get('hf_assets_master'),
      asset_values: get('hf_assets_values'), investment_data: get('hf_investment_data'),
    };
  } catch(e) { return emptyDb(); }
}
function hasData(db) { return Object.values(db).some(v => Array.isArray(v) && v.length > 0); }
function emptyDb() {
  return { finance_records:[], finance_categories:[], useless_expenses:[], stock_transactions:[], stock_prices:[], assets_master:[], asset_values:[], investment_data:[] };
}

// ── Public data accessors ─────────────────────────────────
function loadFinanceRecords()    { return _db.finance_records    || []; }
function loadCategories()        { return _db.finance_categories.length ? _db.finance_categories : seedCategories(2024); }
function loadUselessExpenses()   { return _db.useless_expenses   || []; }
function loadStockTransactions() { return _db.stock_transactions || []; }
function loadStockPrices()       { return _db.stock_prices       || []; }
function loadAssetsMaster()      { return _db.assets_master      || []; }
function loadAssetValues()       { return _db.asset_values       || []; }
function loadInvestmentData()    { return _db.investment_data    || []; }

function saveFinanceRecords(arr)    { _db.finance_records    = arr; saveToLocalStorage(); }
function saveCategories(arr)        { _db.finance_categories = arr; saveToLocalStorage(); }
function saveUselessExpenses(arr)   { _db.useless_expenses   = arr; saveToLocalStorage(); }
function saveStockTransactions(arr) { _db.stock_transactions = arr; saveToLocalStorage(); }
function saveStockPrices(arr)       { _db.stock_prices       = arr; saveToLocalStorage(); }
function saveAssetsMaster(arr)      { _db.assets_master      = arr; saveToLocalStorage(); }
function saveAssetValues(arr)       { _db.asset_values       = arr; saveToLocalStorage(); }
function saveInvestmentData(arr)    { _db.investment_data    = arr; saveToLocalStorage(); }

// ── Excel export ──────────────────────────────────────────
function exportToExcel(sheets) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(s => { const ws = XLSX.utils.json_to_sheet(s.data); XLSX.utils.book_append_sheet(wb, ws, s.name); });
  const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  XLSX.writeFile(wb, `MyFinance_Export_${ts}.xlsx`);
}
function exportAllData() {
  exportToExcel([
    { name:'finance_records', data:loadFinanceRecords() }, { name:'finance_categories', data:loadCategories() },
    { name:'useless_expenses', data:loadUselessExpenses() }, { name:'stock_transactions', data:loadStockTransactions() },
    { name:'stock_prices', data:loadStockPrices() }, { name:'assets_master', data:loadAssetsMaster() },
    { name:'asset_values', data:loadAssetValues() }, { name:'investment_data', data:loadInvestmentData() },
  ]);
}
function exportJsonBackup() {
  const blob = new Blob([JSON.stringify({..._db, exported_at:new Date().toISOString()}, null, 2)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `MyFinance_Backup_${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.json`; a.click();
}

// ── UUID & constants ──────────────────────────────────────
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r=Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16); });
}
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Seed categories ───────────────────────────────────────
function seedCategories(year = 2024) {
  const rows = [];
  const add = (section, group, type, category, order) => rows.push({ category_id:uuid(), section, group, type, category, order, active:true, start_year:year-2, end_year:null, notes:'' });
  add('incoming','Primary','income','Salary',1); add('incoming','Primary','income','Dividends',2);
  add('incoming','Primary','income','Reimbursements',3); add('incoming','Primary','income','Others',4);
  add('outgoing','Living','expense','Mortgage',1); add('outgoing','Living','expense','Child Care / School Fees',2);
  add('outgoing','Living','expense','Credit Card Bill - 3 SC Cash',3); add('outgoing','Living','expense','Small / Daily Expenses',4);
  add('outgoing','Living','expense','Big Ticket Purchases',5); add('outgoing','Insurance','expense','Insurance - 1',1);
  add('outgoing','Insurance','expense','Insurance - 2',2); add('outgoing','Taxes','tax','Income Tax',1);
  add('outgoing','Taxes','tax','Personal Tax',2); add('outgoing','Investments','investment','Manulife Regular Insurance Plan',1);
  add('outgoing','Investments','investment','Manulife Ready Builder 10',2); add('outgoing','Investments','investment','Manulife Ready - 8',3);
  add('outgoing','Investments','investment','DBS STI Unit Trust',4); add('outgoing','Investments','investment','SYFE Equity 100 - ABHI',5);
  add('outgoing','Investments','investment','SYFE Equities 100 - KIARA',6); add('outgoing','Investments','investment','SYFE SG Stocks',7);
  add('outgoing','Investments','investment','IBKR Equities - ABHI',8); add('outgoing','Investments','investment','IBKR Equities - KIARA',9);
  add('outgoing','Investments','investment','SRS Endowus',10); add('outgoing','Investments','investment','SYFE REITS',11);
  saveCategories(rows); return rows;
}

// ── Boot ──────────────────────────────────────────────────
window.addEventListener('load', async () => {
  _db = loadFromLocalStorage();
  if (!hasData(_db)) { _db = emptyDb(); _db.finance_categories = seedCategories(2024); }
  _initialized = true;
  if (typeof window.onDataLoaded === 'function') window.onDataLoaded();
  updateAuthUI(false);
  await initGoogleAuth();
});