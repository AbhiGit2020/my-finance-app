const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('new portfolio accounts appear immediately in the global selector', () => {
  const selector = {};
  const storage = new Map();
  const context = vm.createContext({
    StockCore: require('../js/stock-core.js'),
    console,
    Blob,
    URL,
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    document: {
      querySelectorAll: query => query === '.global-profile-sel' ? [selector] : [],
      getElementById: () => null,
      addEventListener: () => {},
    },
    window: { addEventListener: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
  });
  const source = fs.readFileSync(path.resolve(__dirname, '../js/store.js'), 'utf8');
  vm.runInContext(source, context);

  vm.runInContext(`
    _db = normalizeDb({});
    const accounts = loadPortfolioAccounts();
    accounts.push({ account_id: 'family', name: 'Family', active: true });
    savePortfolioAccounts(accounts);
    setActiveProfile('Family');
  `, context);

  assert.equal(selector.value, 'Family');
  assert.match(selector.innerHTML, />Family</);
  assert.match(selector.innerHTML, />My Portfolio \(All Accounts\)</);
  assert.equal(vm.runInContext('loadPortfolioAccounts()[0].name', context), 'My Portfolio');
});
