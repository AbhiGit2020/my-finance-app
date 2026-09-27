const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/finance-core.js');

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

test('annualTotals includes tax and investment contributions', () => {
  const totals = core.annualTotals([
    { profile: 'Abhi', year: 2025, type: 'income', amount: 100 },
    { profile: 'Abhi', year: 2025, type: 'expense', amount: 20 },
    { profile: 'Abhi', year: 2025, type: 'tax', amount: 10 },
  ], [
    { profile: 'Abhi', year: 2025, metric: 'monthly_investment', amount: 15 },
  ], 'Abhi', 2025);
  assert.deepEqual(totals, { income: 100, outgoing: 30, invested: 15, savings: 55 });
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
  const normalized = core.normalizeDatabase({ finance_records: [{ amount: 10 }], custom_note: 'keep me' }, 1);
  assert.equal(normalized.schema_version, 1);
  assert.equal(normalized.custom_note, 'keep me');
  assert.deepEqual(normalized.finance_records, [{ amount: 10 }]);
  assert.deepEqual(normalized.asset_values, []);
});

test('normalizeDatabase rejects malformed and newer data', () => {
  assert.throws(() => core.normalizeDatabase({ finance_records: {} }, 1), /must be an array/);
  assert.throws(() => core.normalizeDatabase({ schema_version: 2 }, 1), /supports up to 1/);
});

test('mergeDatabases combines local edits with unrelated remote changes', () => {
  const base = {
    finance_records: [{ record_id: 'old', amount: 10 }],
    assets_master: [{ asset_id: 'asset-1', asset_name: 'Cash' }],
  };
  const local = {
    finance_records: [{ record_id: 'new', amount: 25 }],
    assets_master: [{ asset_id: 'asset-1', asset_name: 'Cash' }],
  };
  const remote = {
    finance_records: [{ record_id: 'old', amount: 10 }, { record_id: 'remote', amount: 30 }],
    assets_master: [{ asset_id: 'asset-1', asset_name: 'Savings' }],
  };
  const merged = core.mergeDatabases(base, local, remote);
  assert.deepEqual(merged.finance_records, [{ record_id: 'remote', amount: 30 }, { record_id: 'new', amount: 25 }]);
  assert.deepEqual(merged.assets_master, [{ asset_id: 'asset-1', asset_name: 'Savings' }]);
});

test('mergeDatabases gives an intentional local edit precedence on the same row', () => {
  const base = { budget_targets: [{ budget_id: 'b1', monthly_target: 100 }] };
  const local = { budget_targets: [{ budget_id: 'b1', monthly_target: 120 }] };
  const remote = { budget_targets: [{ budget_id: 'b1', monthly_target: 110 }] };
  assert.equal(core.mergeDatabases(base, local, remote).budget_targets[0].monthly_target, 120);
});

test('occurrenceDates clamps month-end schedules without skipping February', () => {
  assert.deepEqual(core.occurrenceDates({ start_date: '2025-01-31', frequency: 'monthly' }, '2025-04-30'), [
    '2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30',
  ]);
});

test('projectRetirement handles a zero return rate', () => {
  const result = core.projectRetirement({ currentValue: 100000, currentAge: 40, retirementAge: 50, annualSpending: 40000, monthlyContribution: 1000, expectedReturn: 0, withdrawalRate: 4 });
  assert.equal(result.projected, 220000);
  assert.equal(result.target, 1000000);
  assert.equal(result.gap, -780000);
});
