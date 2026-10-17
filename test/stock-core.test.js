const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/stock-core.js');

test('computeHoldings uses FIFO lots and dated FX', () => {
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
  assert.equal(result.holdings[0].avg_cost, 23);
  assert.equal(result.realRows[0].realized_pnl, 145);
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

test('computeHoldings includes commissions in cost basis and realized P&L', () => {
  const result = core.computeHoldings([
    { ticker: 'ABC', action: 'BUY', qty: 10, price: 10, commission: 2, currency: 'SGD', date: '2025-01-01' },
    { ticker: 'ABC', action: 'SELL', qty: 5, price: 12, commission: 1, currency: 'SGD', date: '2025-02-01' },
  ]);
  assert.equal(result.holdings[0].cost_basis, 51);
  assert.equal(result.holdings[0].avg_cost, 10.2);
  assert.ok(Math.abs(result.holdings[0].realized_pnl - 8) < 1e-9);
});

test('computeHoldings applies an audited cost basis adjustment without changing quantity', () => {
  const result = core.computeHoldings([
    { ticker: 'ABC', action: 'BUY', qty: 10, price: 10, commission: 2, cost_basis_adjustment: -12, currency: 'USD', date: '2025-01-01' },
  ]);
  assert.equal(result.holdings[0].qty, 10);
  assert.equal(result.holdings[0].cost_basis, 90);
  assert.equal(result.holdings[0].avg_cost, 9);
});

test('computeConsolidatedHoldings preserves account-level FIFO before combining accounts', () => {
  const transactions = [
    { profile: 'Abhi', ticker: 'ABC', action: 'BUY', qty: 2, price: 10, currency: 'USD', date: '2025-01-01' },
    { profile: 'Abhi', ticker: 'ABC', action: 'SELL', qty: 1, price: 30, currency: 'USD', date: '2025-03-01' },
    { profile: 'Kiara', ticker: 'ABC', action: 'BUY', qty: 3, price: 20, currency: 'USD', date: '2025-02-01' },
    { profile: 'Retired', ticker: 'ABC', action: 'BUY', qty: 5, price: 1, currency: 'USD', date: '2025-01-01' },
  ];
  const result = core.computeConsolidatedHoldings(transactions, ['Abhi', 'Kiara']);
  assert.equal(result.holdings[0].qty, 4);
  assert.equal(result.holdings[0].cost_basis, 70);
  assert.equal(result.holdings[0].avg_cost, 17.5);
  assert.equal(result.holdings[0].realized_pnl, 20);
  assert.equal(result.realRows[0].open_qty, 4);
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

test('performance series starts at zero and ignores leading empty values', () => {
  assert.deepEqual(core.performanceSeries([0, 100, 110, 90]), [null, 0, 10, -10]);
  assert.deepEqual(core.performanceSeries([0, 0]), [null, null]);
});

test('chain return series compounds period returns without treating cash flows as gains', () => {
  const result = core.chainReturnSeries([0, 0.1, -0.05]);
  assert.equal(result[0], 0);
  assert.ok(Math.abs(result[1] - 10) < 1e-9);
  assert.ok(Math.abs(result[2] - 4.5) < 1e-9);
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
