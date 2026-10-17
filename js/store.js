// Local JSON storage, shared stock helpers, and UI utilities.

const DB_SCHEMA_VERSION = 1;
const DATA_COLLECTION_KEYS = StockCore.DATA_COLLECTION_KEYS;
const STOCK_FX_TO_SGD = StockCore.DEFAULT_FX_TO_SGD;
const SS_FINNHUB = 'hf_finnhub_key';
const PROFILE_KEY = 'hf_active_profile';

let _db = emptyDb();
let _dataReady = false;
let _loadFailed = false;
let _unsavedChanges = false;
let _lastSaveTime = null;
let _savePromise = null;
let _autoSaveTimer = null;

function emptyDb() {
  return {
    schema_version: DB_SCHEMA_VERSION,
    portfolio_accounts: [],
    stock_transactions: [],
    stock_prices: [],
    stock_watchlists: [],
    stock_tracker_symbols: [],
    stock_tracker_prices: [],
    fx_rates: [],
  };
}

function normalizeDb(data) {
  const normalized = { ...emptyDb(), ...StockCore.normalizeDatabase(data, DB_SCHEMA_VERSION) };
  normalized.portfolio_accounts = (normalized.portfolio_accounts || []).filter(account => !String(account.name || '').startsWith('__'));
  const accountNames = new Set(normalized.portfolio_accounts.map(account => account.name).filter(Boolean));
  ['stock_transactions', 'stock_prices', 'stock_watchlists', 'stock_tracker_symbols', 'stock_tracker_prices'].forEach(collection => {
    (normalized[collection] || []).forEach(row => {
      if (row.profile && !String(row.profile).startsWith('__')) accountNames.add(row.profile);
    });
  });
  if (!accountNames.size) accountNames.add('My Portfolio');
  const existingByName = new Map((normalized.portfolio_accounts || []).map(account => [account.name, account]));
  normalized.portfolio_accounts = [...accountNames].map(name => existingByName.get(name) || {
    account_id: `account-${slugId(name)}`,
    name,
    active: true,
    created_at: new Date().toISOString(),
  });
  return normalized;
}

function slugId(value) {
  return String(value || 'portfolio').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'portfolio';
}

function getActiveProfile() {
  const accounts = loadPortfolioAccounts().filter(account => account.active !== false);
  const saved = localStorage.getItem(PROFILE_KEY);
  return accounts.some(account => account.name === saved) ? saved : (accounts[0]?.name || 'My Portfolio');
}

function setActiveProfile(name) {
  localStorage.setItem(PROFILE_KEY, name);
  initProfileSelector();
  if (typeof window.onProfileChange === 'function') window.onProfileChange();
  if (typeof window.onDataLoaded === 'function') window.onDataLoaded();
}

function initProfileSelector() {
  const active = getActiveProfile();
  const accounts = loadPortfolioAccounts().filter(account => account.active !== false);
  document.querySelectorAll('.global-profile-sel').forEach(select => {
    select.innerHTML = accounts.map(account =>
      `<option value="${escapeAttr(account.name)}" ${account.name === active ? 'selected' : ''}>${escapeHtml(account.name)}</option>`
    ).join('');
    select.value = active;
    select.onchange = () => setActiveProfile(select.value);
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function jsArg(value) {
  return escapeHtml(JSON.stringify(String(value ?? '')));
}

function showStatus(message, color) {
  const element = document.getElementById('storageStatus') || document.getElementById('driveStatus');
  if (!element) return;
  element.textContent = message;
  if (color) element.style.color = color;
}

function showLoading(message) {
  const overlay = document.getElementById('loadingOverlay');
  const label = document.getElementById('loadingMsg');
  if (overlay) { overlay.style.display = 'flex'; overlay.style.opacity = '1'; }
  if (label && message) label.textContent = message;
}

function triggerRender() {
  initProfileSelector();
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.style.opacity = '0';
    setTimeout(() => { overlay.style.display = 'none'; }, 300);
  }
  if (typeof window.onDataLoaded === 'function') window.onDataLoaded();
  requestAnimationFrame(ensureActiveTableScroller);
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function loadLocalData() {
  try {
    showStatus('Loading local data...', 'var(--text-muted)');
    _db = normalizeDb(await apiRequest('/api/data'));
    _dataReady = true;
    _loadFailed = false;
    _unsavedChanges = false;
    showStatus('Local data ready', 'var(--green)');
    triggerRender();
    return true;
  } catch (error) {
    console.error('loadLocalData:', error);
    _dataReady = true;
    _loadFailed = true;
    showStatus('Local data could not be loaded', 'var(--red)');
    triggerRender();
    return false;
  }
}

async function reloadLocalDataSafely() {
  if (_unsavedChanges && !confirm('Reload the JSON file and discard unsaved changes in this window?')) return false;
  showLoading('Refreshing local stock data...');
  return loadLocalData();
}

async function localSave() {
  if (_savePromise) return _savePromise;
  _savePromise = performLocalSave();
  try { return await _savePromise; }
  finally { _savePromise = null; }
}

async function performLocalSave() {
  if (_loadFailed) {
    showStatus('Save blocked until data reloads', 'var(--red)');
    return false;
  }
  try {
    showStatus('Saving...', 'var(--text-muted)');
    const result = await apiRequest('/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_db),
    });
    _unsavedChanges = false;
    _lastSaveTime = result.saved_at || new Date().toISOString();
    showStatus(`Saved locally at ${new Date(_lastSaveTime).toLocaleTimeString()}`, 'var(--green)');
    return true;
  } catch (error) {
    console.error('localSave:', error);
    showStatus('Local save failed', 'var(--red)');
    return false;
  }
}

async function localBackup() {
  try {
    if (_unsavedChanges && !(await localSave())) return false;
    const result = await apiRequest('/api/backup', { method: 'POST' });
    showStatus(`Backup created: ${result.name}`, 'var(--green)');
    return true;
  } catch (error) {
    console.error('localBackup:', error);
    showStatus('Backup failed', 'var(--red)');
    return false;
  }
}

async function backupBeforeDestructiveAction(label) {
  showStatus('Creating safety backup...', 'var(--text-muted)');
  const backedUp = await localBackup();
  if (!backedUp) alert(`The safety backup failed, so ${label} was cancelled.`);
  return backedUp;
}

function getFinnhubKey() {
  let key = (localStorage.getItem(SS_FINNHUB) || '').trim();
  if (!key) {
    key = (prompt('Enter your Finnhub API key. It stays in this browser on your computer.') || '').trim();
    if (key) localStorage.setItem(SS_FINNHUB, key);
  }
  return key;
}

async function fetchLocalQuote(symbol) {
  const key = getFinnhubKey();
  if (!key) throw new Error('Missing Finnhub API key');
  return apiRequest(`/api/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`);
}

async function fetchLocalHistory(symbol, from, to) {
  const key = (localStorage.getItem(SS_FINNHUB) || '').trim();
  const params = new URLSearchParams({ symbol, from, to });
  if (key) params.set('token', key);
  return apiRequest(`/api/history?${params}`);
}

function loadStockTransactions() { return _db.stock_transactions || []; }
function loadPortfolioAccounts() { return _db.portfolio_accounts || []; }
function loadStockPrices() { return _db.stock_prices || []; }
function loadStockWatchlists() { return _db.stock_watchlists || []; }
function loadStockTrackerSymbols() { return _db.stock_tracker_symbols || []; }
function loadStockTrackerPrices() { return _db.stock_tracker_prices || []; }
function loadFxRates() { return _db.fx_rates || []; }

function saveStockTransactions(rows) { _db.stock_transactions = rows; markUnsaved(); }
function savePortfolioAccounts(rows) { _db.portfolio_accounts = rows; markUnsaved(); }
function saveStockPrices(rows) { _db.stock_prices = rows; markUnsaved(); }
function saveStockWatchlists(rows) { _db.stock_watchlists = rows; markUnsaved(); }
function saveStockTrackerSymbols(rows) { _db.stock_tracker_symbols = rows; markUnsaved(); }
function saveStockTrackerPrices(rows) { _db.stock_tracker_prices = rows; markUnsaved(); }
function saveFxRates(rows) { _db.fx_rates = rows; markUnsaved(); }

function exportToExcel(sheets) {
  const workbook = XLSX.utils.book_new();
  sheets.forEach(sheet => {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sheet.data), sheet.name);
  });
  XLSX.writeFile(workbook, `StockAnalysis_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function exportAllData() {
  exportToExcel([
    { name: 'portfolio_accounts', data: loadPortfolioAccounts() },
    { name: 'stock_transactions', data: loadStockTransactions() },
    { name: 'stock_prices', data: loadStockPrices() },
    { name: 'stock_watchlists', data: loadStockWatchlists() },
    { name: 'stock_tracker_symbols', data: loadStockTrackerSymbols() },
    { name: 'stock_tracker_prices', data: loadStockTrackerPrices() },
    { name: 'fx_rates', data: loadFxRates() },
  ]);
}

function exportJsonBackup() {
  const blob = new Blob([JSON.stringify({ ..._db, exported_at: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `StockAnalysis_Backup_${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function importJsonBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (!DATA_COLLECTION_KEYS.some(key => Array.isArray(data[key]))) throw new Error('Unrecognized stock backup');
        if (!confirm('Import this stock backup and replace the current local data?')) return;
        if (!(await localBackup())) throw new Error('Could not back up current local data');
        _db = normalizeDb(data);
        _loadFailed = false;
        markUnsaved();
        await localSave();
        triggerRender();
      } catch (error) {
        console.error('importJsonBackup:', error);
        alert('Could not import this JSON backup. Please choose a valid Stock Analysis JSON file.');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function appFxToSgd(currency, date) {
  return StockCore.fxRateToSgd(currency, date, loadFxRates(), STOCK_FX_TO_SGD);
}

function appFxToUsd(currency, date) {
  return StockCore.fxRateBetween(currency, 'USD', date, loadFxRates(), STOCK_FX_TO_SGD);
}

function latestStockPrice(profile, ticker) {
  return loadStockPrices()
    .filter(row => row.profile === profile && row.ticker === ticker)
    .reduce((best, row) => (!best || String(row.asof_date || '') > String(best.asof_date || '')) ? row : best, null);
}

function stockPriceAsOf(profile, ticker, date) {
  return loadStockPrices()
    .filter(row => row.profile === profile && row.ticker === ticker && String(row.asof_date || '') <= date)
    .reduce((best, row) => (!best || String(row.asof_date || '') > String(best.asof_date || '')) ? row : best, null);
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const random = Math.random() * 16 | 0;
    return (char === 'x' ? random : (random & 0x3 | 0x8)).toString(16);
  });
}

function markUnsaved() {
  _unsavedChanges = true;
  showStatus('Unsaved changes', 'var(--yellow)');
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => { if (_unsavedChanges) localSave(); }, 1200);
}

window.addEventListener('beforeunload', event => {
  if (!_unsavedChanges) return;
  event.preventDefault();
  event.returnValue = 'You have unsaved local changes.';
  return event.returnValue;
});

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
  _tableScrollControls.style.setProperty('--table-scroll-y', `${y}px`);
  const left = _tableScrollControls.querySelector('[data-table-scroll="left"]');
  const right = _tableScrollControls.querySelector('[data-table-scroll="right"]');
  left.style.left = `${Math.max(10, rect.left + 10)}px`;
  right.style.left = `${Math.min(window.innerWidth - 52, rect.right - 52)}px`;
  left.disabled = wrap.scrollLeft <= 2;
  right.disabled = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 2;
}

function initFloatingTableScroll() {
  if (_tableScrollControls) return;
  const controls = document.createElement('div');
  controls.className = 'floating-table-scroll';
  controls.innerHTML = `
    <button type="button" class="table-scroll-arrow" data-table-scroll="left" aria-label="Scroll table left" title="Scroll table left">&larr;</button>
    <button type="button" class="table-scroll-arrow" data-table-scroll="right" aria-label="Scroll table right" title="Scroll table right">&rarr;</button>`;
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

window.addEventListener('load', async () => {
  initFloatingTableScroll();
  await loadLocalData();
});
