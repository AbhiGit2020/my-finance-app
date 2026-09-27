(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FinanceCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_FX_TO_SGD = Object.freeze({
    SGD: 1,
    USD: 1.35,
    EUR: 1.46,
    INR: 0.0161,
    GBP: 1.72,
    HKD: 0.173,
    AUD: 0.91,
  });
  const DATA_COLLECTION_KEYS = Object.freeze([
    'finance_records', 'finance_categories', 'useless_expenses',
    'stock_transactions', 'stock_prices', 'stock_watchlists',
    'stock_tracker_symbols', 'stock_tracker_prices', 'assets_master',
    'asset_values', 'investment_data', 'fx_rates', 'budget_targets',
    'recurring_transactions', 'planning_settings',
  ]);
  const COLLECTION_ID_FIELDS = Object.freeze({
    finance_records: ['record_id'],
    finance_categories: ['category_id'],
    useless_expenses: ['entry_id'],
    stock_transactions: ['txn_id'],
    stock_prices: ['profile', 'ticker', 'asof_date'],
    stock_watchlists: ['watchlist_id'],
    stock_tracker_symbols: ['symbol_id'],
    stock_tracker_prices: ['price_id'],
    assets_master: ['asset_id'],
    asset_values: ['valuation_id'],
    investment_data: ['record_id'],
    fx_rates: ['rate_id'],
    budget_targets: ['budget_id'],
    recurring_transactions: ['recurring_id'],
    planning_settings: ['setting_id'],
  });

  function number(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function latestDatedRow(rows, dateField = 'date') {
    return (rows || []).reduce((best, row) => {
      if (!best) return row;
      return String(row?.[dateField] || '') > String(best?.[dateField] || '') ? row : best;
    }, null);
  }

  function fxRateToSgd(currency, date, rates, defaults = DEFAULT_FX_TO_SGD) {
    const code = String(currency || 'SGD').toUpperCase();
    const asOf = String(date || '9999-12-31');
    const candidates = (rates || [])
      .filter(row => String(row.currency || '').toUpperCase() === code && String(row.asof_date || '') <= asOf)
      .sort((a, b) => String(b.asof_date || '').localeCompare(String(a.asof_date || '')));
    const storedRate = number(candidates[0]?.rate_to_sgd);
    if (storedRate > 0) return storedRate;
    return number(defaults[code]) || 1;
  }

  function convertToSgd(amount, currency, date, rates, defaults) {
    return number(amount) * fxRateToSgd(currency, date, rates, defaults);
  }

  function computeHoldings(transactions, rateResolver) {
    const positions = {};
    const realized = {};
    const resolveRate = typeof rateResolver === 'function' ? rateResolver : () => 1;

    [...(transactions || [])]
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
      .forEach(row => {
        const ticker = String(row.ticker || '').trim().toUpperCase();
        if (!ticker) return;
        const qty = number(row.qty);
        const price = number(row.price);
        const currency = String(row.currency || 'SGD').toUpperCase();
        const priceSgd = price * number(resolveRate(currency, row.date));
        if (!positions[ticker]) positions[ticker] = { qty: 0, cost: 0, currency };
        if (!Object.hasOwn(realized, ticker)) realized[ticker] = 0;
        positions[ticker].currency = currency;

        if (String(row.action || '').toUpperCase() === 'BUY') {
          positions[ticker].qty += qty;
          positions[ticker].cost += qty * priceSgd;
          return;
        }

        const sellQty = Math.min(qty, Math.max(positions[ticker].qty, 0));
        const averageCost = positions[ticker].qty > 0 ? positions[ticker].cost / positions[ticker].qty : 0;
        realized[ticker] += sellQty * (priceSgd - averageCost);
        positions[ticker].qty -= sellQty;
        positions[ticker].cost -= sellQty * averageCost;
        if (Math.abs(positions[ticker].qty) < 0.0000001) {
          positions[ticker].qty = 0;
          positions[ticker].cost = 0;
        }
      });

    const holdings = [];
    const realRows = [];
    Object.entries(positions).forEach(([ticker, position]) => {
      const averageCost = position.qty > 0 ? position.cost / position.qty : 0;
      if (position.qty > 0.0001) {
        holdings.push({
          ticker,
          qty: position.qty,
          currency: position.currency || 'SGD',
          avg_cost: averageCost,
          cost_basis: position.cost,
          realized_pnl: realized[ticker] || 0,
        });
      }
      if (realized[ticker]) realRows.push({ ticker, realized_pnl: realized[ticker], open_qty: position.qty });
    });
    return { holdings, realRows };
  }

  function annualTotals(financeRecords, investmentData, profile, year) {
    const records = (financeRecords || []).filter(row => (row.profile || 'Abhi') === profile && number(row.year) === number(year));
    const income = records.filter(row => row.type === 'income').reduce((sum, row) => sum + number(row.amount), 0);
    const outgoing = records.filter(row => row.type === 'expense' || row.type === 'tax').reduce((sum, row) => sum + number(row.amount), 0);
    const invested = (investmentData || [])
      .filter(row => (row.profile || 'Abhi') === profile && number(row.year) === number(year) && row.metric === 'monthly_investment')
      .reduce((sum, row) => sum + number(row.amount), 0);
    return { income, outgoing, invested, savings: income - outgoing - invested };
  }

  function normalizeDatabase(data, schemaVersion = 1) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Backup must be a JSON object');
    const incomingVersion = Number.parseInt(data.schema_version || 0, 10);
    if (incomingVersion > schemaVersion) {
      throw new Error(`This data uses schema ${incomingVersion}; this app supports up to ${schemaVersion}`);
    }
    DATA_COLLECTION_KEYS.forEach(key => {
      if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error(`${key} must be an array`);
    });
    const normalized = { ...data, schema_version: schemaVersion };
    DATA_COLLECTION_KEYS.forEach(key => { normalized[key] = Array.isArray(data[key]) ? data[key] : []; });
    return normalized;
  }

  function rowIdentity(collection, row, index = 0) {
    const configured = COLLECTION_ID_FIELDS[collection] || [];
    if (configured.length && configured.every(field => row?.[field] !== undefined && row?.[field] !== '')) {
      return configured.map(field => String(row[field])).join('|');
    }
    const fallbacks = {
      finance_records: ['profile', 'year', 'month', 'type', 'category', 'created_at'],
      finance_categories: ['section', 'category', 'start_year'],
      useless_expenses: ['profile', 'date', 'amount_sgd', 'note'],
      stock_transactions: ['profile', 'ticker', 'date', 'action', 'qty', 'price'],
      stock_tracker_prices: ['profile', 'symbol', 'asof_date'],
      asset_values: ['asset_id', 'date', 'created_at'],
      investment_data: ['profile', 'year', 'month', 'category', 'metric'],
      planning_settings: ['profile'],
    };
    const fields = fallbacks[collection] || [];
    if (fields.length && fields.some(field => row?.[field] !== undefined && row?.[field] !== '')) {
      return fields.map(field => String(row?.[field] ?? '')).join('|');
    }
    return `row-${index}-${JSON.stringify(row)}`;
  }

  function rowsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function mergeCollection(collection, baseRows, localRows, remoteRows) {
    const toMap = rows => new Map((rows || []).map((row, index) => [rowIdentity(collection, row, index), row]));
    const base = toMap(baseRows);
    const local = toMap(localRows);
    const merged = toMap(remoteRows);

    base.forEach((_, key) => {
      if (!local.has(key)) merged.delete(key);
    });
    local.forEach((row, key) => {
      if (!base.has(key) || !rowsEqual(row, base.get(key))) merged.set(key, row);
    });
    return [...merged.values()];
  }

  function mergeDatabases(baseData, localData, remoteData, schemaVersion = 1) {
    const base = normalizeDatabase(baseData || {}, schemaVersion);
    const local = normalizeDatabase(localData || {}, schemaVersion);
    const remote = normalizeDatabase(remoteData || {}, schemaVersion);
    const merged = { ...remote, ...local, schema_version: schemaVersion };
    DATA_COLLECTION_KEYS.forEach(collection => {
      merged[collection] = mergeCollection(collection, base[collection], local[collection], remote[collection]);
    });
    return merged;
  }

  function occurrenceDates(schedule, throughDate) {
    const [startYear, startMonth, startDay] = String(schedule.start_date || '').split('-').map(Number);
    if (!startYear || !startMonth || !startDay || !throughDate) return [];
    const stopText = schedule.end_date && schedule.end_date < throughDate ? schedule.end_date : throughDate;
    const results = [];
    for (let index = 0; index < 600; index++) {
      const year = schedule.frequency === 'yearly' ? startYear + index : startYear + Math.floor((startMonth - 1 + index) / 12);
      const month = schedule.frequency === 'yearly' ? startMonth : ((startMonth - 1 + index) % 12) + 1;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const day = Math.min(startDay, lastDay);
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (date > stopText) break;
      if (date >= schedule.start_date) results.push(date);
    }
    return results;
  }

  function projectRetirement({ currentValue, currentAge, retirementAge, annualSpending, monthlyContribution, expectedReturn, withdrawalRate }) {
    const years = Math.max(0, number(retirementAge) - number(currentAge));
    const months = years * 12;
    const monthlyRate = number(expectedReturn) / 100 / 12;
    const futureCurrent = number(currentValue) * Math.pow(1 + monthlyRate, months);
    const futureContributions = monthlyRate
      ? number(monthlyContribution) * (Math.pow(1 + monthlyRate, months) - 1) / monthlyRate
      : number(monthlyContribution) * months;
    const projected = futureCurrent + futureContributions;
    const target = number(withdrawalRate) > 0 ? number(annualSpending) / (number(withdrawalRate) / 100) : 0;
    return { years, projected, target, gap: projected - target };
  }

  return { DEFAULT_FX_TO_SGD, DATA_COLLECTION_KEYS, number, latestDatedRow, fxRateToSgd, convertToSgd, computeHoldings, annualTotals, normalizeDatabase, mergeDatabases, occurrenceDates, projectRetirement };
});
