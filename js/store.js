// ============================================================
// store.js — Central data layer (localStorage + Excel export)
// ============================================================

const KEYS = {
  financeRecords:   'hf_finance_records',
  financeCategories:'hf_finance_categories',
  uselessExpenses:  'hf_useless_expenses',
  stockTransactions:'hf_stock_transactions',
  stockPrices:      'hf_stock_prices',
  assetsMaster:     'hf_assets_master',
  assetsValues:     'hf_assets_values',
  investmentData:   'hf_investment_data',
};

// ── Generic read/write ─────────────────────────────────────
function loadKey(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch(e) { return []; }
}

function saveKey(key, arr) {
  try { localStorage.setItem(key, JSON.stringify(arr)); }
  catch(e) { console.error('store.js saveKey error', e); }
}

// ── Finance Records ───────────────────────────────────────
function loadFinanceRecords() { return loadKey(KEYS.financeRecords); }
function saveFinanceRecords(arr) { saveKey(KEYS.financeRecords, arr); }

// ── Finance Categories ────────────────────────────────────
function loadCategories() {
  const arr = loadKey(KEYS.financeCategories);
  if (arr.length === 0) return seedCategories(2024);
  return arr;
}
function saveCategories(arr) { saveKey(KEYS.financeCategories, arr); }

// ── Useless Expenses ──────────────────────────────────────
function loadUselessExpenses() { return loadKey(KEYS.uselessExpenses); }
function saveUselessExpenses(arr) { saveKey(KEYS.uselessExpenses, arr); }

// ── Stock Transactions ────────────────────────────────────
function loadStockTransactions() { return loadKey(KEYS.stockTransactions); }
function saveStockTransactions(arr) { saveKey(KEYS.stockTransactions, arr); }

// ── Stock Prices ──────────────────────────────────────────
function loadStockPrices() { return loadKey(KEYS.stockPrices); }
function saveStockPrices(arr) { saveKey(KEYS.stockPrices, arr); }

// ── Assets Master ─────────────────────────────────────────
function loadAssetsMaster() { return loadKey(KEYS.assetsMaster); }
function saveAssetsMaster(arr) { saveKey(KEYS.assetsMaster, arr); }

// ── Asset Values ──────────────────────────────────────────
function loadAssetValues() { return loadKey(KEYS.assetsValues); }
function saveAssetValues(arr) { saveKey(KEYS.assetsValues, arr); }

// ── Investment Data ───────────────────────────────────────
function loadInvestmentData() { return loadKey(KEYS.investmentData); }
function saveInvestmentData(arr) { saveKey(KEYS.investmentData, arr); }

// ── UUID ──────────────────────────────────────────────────
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ── Seed categories ───────────────────────────────────────
function seedCategories(year = 2024) {
  const rows = [];
  let id = 1;
  const add = (section, group, type, category, order) => {
    rows.push({
      category_id: uuid(), section, group, type, category,
      order, active: true, start_year: year - 2, end_year: null, notes: ''
    });
  };
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
  saveCategories(rows);
  return rows;
}

// ── Constants ─────────────────────────────────────────────
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_NUMS = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};

// ── Finance helpers ───────────────────────────────────────
function getFinancePivot(year, section, categories) {
  const records = loadFinanceRecords();
  const typeMap = {incoming: ['income'], outgoing: ['expense','tax','investment']};
  const types = typeMap[section];
  const yearRecs = records.filter(r => r.year === year && types.includes(r.type));

  return categories.map(cat => {
    const row = { Category: cat.category };
    MONTHS.forEach((m, i) => {
      const monthNum = i + 1;
      const rec = yearRecs.find(r => r.category === cat.category && r.month === monthNum);
      row[m] = rec ? rec.amount : 0;
    });
    return row;
  });
}

function saveFinancePivot(year, section, pivotRows) {
  const typeMap = {incoming: 'income', outgoing: 'expense'};
  const categories = loadCategories();
  let records = loadFinanceRecords();

  // remove old records for this year/section
  const sectionCats = categories
    .filter(c => c.section === section)
    .map(c => c.category);

  records = records.filter(r => !(r.year === year && sectionCats.includes(r.category)));

  // write new
  const now = new Date().toISOString();
  pivotRows.forEach(row => {
    const cat = categories.find(c => c.category === row.Category);
    if (!cat) return;
    MONTHS.forEach((m, i) => {
      const val = parseFloat(row[m]) || 0;
      if (val === 0) return;
      records.push({
        record_id: uuid(),
        year, month: i + 1,
        type: cat.type,
        category: row.Category,
        amount: val,
        notes: '',
        created_at: now,
        updated_at: now,
      });
    });
  });

  saveFinanceRecords(records);
}

// ── Excel Export (uses SheetJS loaded on page) ────────────
function exportToExcel(sheets) {
  // sheets = [{name, data: [{col:val},...]}]
  const wb = XLSX.utils.book_new();
  sheets.forEach(s => {
    const ws = XLSX.utils.json_to_sheet(s.data);
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  });
  const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  XLSX.writeFile(wb, `MyFinance_Export_${ts}.xlsx`);
}

function exportAllData() {
  exportToExcel([
    { name: 'finance_records',    data: loadFinanceRecords() },
    { name: 'finance_categories', data: loadCategories() },
    { name: 'useless_expenses',   data: loadUselessExpenses() },
    { name: 'stock_transactions', data: loadStockTransactions() },
    { name: 'stock_prices',       data: loadStockPrices() },
    { name: 'assets_master',      data: loadAssetsMaster() },
    { name: 'asset_values',       data: loadAssetValues() },
    { name: 'investment_data',    data: loadInvestmentData() },
  ]);
}

// ── Import from JSON backup ───────────────────────────────
function importFromJson(jsonStr) {
  try {
    const obj = JSON.parse(jsonStr);
    Object.entries(KEYS).forEach(([k, storageKey]) => {
      const dataKey = {
        financeRecords:'finance_records',
        financeCategories:'finance_categories',
        uselessExpenses:'useless_expenses',
        stockTransactions:'stock_transactions',
        stockPrices:'stock_prices',
        assetsMaster:'assets_master',
        assetsValues:'asset_values',
        investmentData:'investment_data',
      }[k];
      if (obj[dataKey]) saveKey(storageKey, obj[dataKey]);
    });
    return true;
  } catch(e) { return false; }
}

function exportJsonBackup() {
  const obj = {
    finance_records:    loadFinanceRecords(),
    finance_categories: loadCategories(),
    useless_expenses:   loadUselessExpenses(),
    stock_transactions: loadStockTransactions(),
    stock_prices:       loadStockPrices(),
    assets_master:      loadAssetsMaster(),
    asset_values:       loadAssetValues(),
    investment_data:    loadInvestmentData(),
    exported_at:        new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(obj, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  a.download = `MyFinance_Backup_${ts}.json`;
  a.click();
}
