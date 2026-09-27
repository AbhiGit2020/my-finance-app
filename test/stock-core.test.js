const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/stock-core.js');

test('computeHoldings uses average cost and dated FX', () => {
  const rates = [
    { currency: 'USD', asof_date: '2025-01-01', rate_to_sgd: 1.3 },
    { currency: 'USD', asof_date: '2025-06-01', rate_to_sgd: 1.4 },
  ];
  const transactions = [
    { ticker: 'ABC', action: 'BUY', qty: 10, price: 10, currency: 'USD', date: '2025-02-01' },
    { ticker: 'ABC', action: 'BUY', qty: 10, price: 20, currency: 'USD', date: '2025-07-01' },
    { ticker: 'ABC', action: 'SELL', qty: 5, price: 30, currency: 'USD', date: '2025-08-01' },
  ];
  const result = core.computeHoldings(transactions, (currency, date) => core.fxRateToSgd(currency, date, rates));
  assert.equal(result.holdings[0].qty, 15);
  assert.equal(result.holdings[0].avg_cost, 20.5);
  assert.equal(result.realRows[0].realized_pnl, 107.5);
});

test('computeHoldings never creates a negative position from an oversized sell', () => {
  const result = core.computeHoldings([
    { ticker: 'ABC', action: 'BUY', qty: 2, price: 10, date: '2025-01-01' },
    { ticker: 'ABC', action: 'SELL', qty: 5, price: 12, date: '2025-02-01' },
  ]);
  assert.equal(result.holdings.length, 0);
  assert.equal(result.realRows[0].open_qty, 0);
  assert.equal(result.realRows[0].realized_pnl, 4);
});

test('dated FX uses the latest rate on or before the transaction date', () => {
  const rates = [
    { currency: 'USD', asof_date: '2025-01-01', rate_to_sgd: 1.31 },
    { currency: 'USD', asof_date: '2025-03-01', rate_to_sgd: 1.34 },
  ];
  assert.equal(core.fxRateToSgd('USD', '2025-02-01', rates), 1.31);
  assert.equal(core.fxRateToSgd('USD', '2025-04-01', rates), 1.34);
  assert.equal(core.fxRateToSgd('SGD', '2025-04-01', rates), 1);
});

test('normalizeDatabase preserves unknown fields and fills missing collections', () => {
  const normalized = core.normalizeDatabase({ finance_records: [{ amount: 10 }], stock_transactions: [{ txn_id: 't1' }], custom_note: 'keep me' }, 1);
  assert.equal(normalized.schema_version, 1);
  assert.equal(normalized.custom_note, 'keep me');
  assert.deepEqual(normalized.finance_records, [{ amount: 10 }]);
  assert.deepEqual(normalized.stock_transactions, [{ txn_id: 't1' }]);
  assert.deepEqual(normalized.stock_prices, []);
});

test('normalizeDatabase rejects malformed and newer data', () => {
  assert.throws(() => core.normalizeDatabase({ stock_transactions: {} }, 1), /must be an array/);
  assert.throws(() => core.normalizeDatabase({ schema_version: 2 }, 1), /supports up to 1/);
});

test('mergeDatabases combines local edits with unrelated remote changes', () => {
  const base = {
    stock_transactions: [{ txn_id: 'old', ticker: 'AAA' }],
    stock_watchlists: [{ watchlist_id: 'w1', name: 'Core' }],
  };
  const local = {
    stock_transactions: [{ txn_id: 'new', ticker: 'BBB' }],
    stock_watchlists: [{ watchlist_id: 'w1', name: 'Core' }],
  };
  const remote = {
    stock_transactions: [{ txn_id: 'old', ticker: 'AAA' }, { txn_id: 'remote', ticker: 'CCC' }],
    stock_watchlists: [{ watchlist_id: 'w1', name: 'Long Term' }],
  };
  const merged = core.mergeDatabases(base, local, remote);
  assert.deepEqual(merged.stock_transactions, [{ txn_id: 'remote', ticker: 'CCC' }, { txn_id: 'new', ticker: 'BBB' }]);
  assert.deepEqual(merged.stock_watchlists, [{ watchlist_id: 'w1', name: 'Long Term' }]);
});

test('mergeDatabases gives an intentional local edit precedence on the same row', () => {
  const base = { stock_watchlists: [{ watchlist_id: 'w1', name: 'Core' }] };
  const local = { stock_watchlists: [{ watchlist_id: 'w1', name: 'Local' }] };
  const remote = { stock_watchlists: [{ watchlist_id: 'w1', name: 'Remote' }] };
  assert.equal(core.mergeDatabases(base, local, remote).stock_watchlists[0].name, 'Local');
});
