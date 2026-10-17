(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.StockCore = api;
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
    'portfolio_accounts',
    'stock_transactions', 'stock_prices', 'stock_watchlists',
    'stock_tracker_symbols', 'stock_tracker_prices', 'fx_rates',
  ]);
  const COLLECTION_ID_FIELDS = Object.freeze({
    portfolio_accounts: ['account_id'],
    stock_transactions: ['txn_id'],
    stock_prices: ['profile', 'ticker', 'asof_date'],
    stock_watchlists: ['watchlist_id'],
    stock_tracker_symbols: ['symbol_id'],
    stock_tracker_prices: ['price_id'],
    fx_rates: ['rate_id'],
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

  function performanceSeries(values) {
    const baseline = (values || []).find(value => Number.isFinite(number(value)) && number(value) > 0);
    if (!baseline) return (values || []).map(() => null);
    let started = false;
    return values.map(value => {
      const current = number(value);
      if (!started && current > 0) started = true;
      if (!started || current <= 0) return null;
      return ((current - baseline) / baseline) * 100;
    });
  }

  function chainReturnSeries(periodReturns) {
    let factor = 1;
    return (periodReturns || []).map((value, index) => {
      if (index === 0) return 0;
      factor *= 1 + number(value);
      return (factor - 1) * 100;
    });
  }

  function investmentReturnSeries(values, flows, openingCapital = 0) {
    let purchases = 0;
    let sales = 0;
    return (values || []).map((value, index) => {
      const flow = flows?.[index] || {};
      purchases += number(flow.purchases);
      sales += number(flow.sales);
      const invested = number(openingCapital) + purchases;
      if (invested <= 0) return null;
      const gain = number(value) + sales - number(openingCapital) - purchases;
      return gain / invested * 100;
    });
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
        const rate = number(resolveRate(currency, row.date));
        const priceSgd = price * rate;
        const commissionSgd = Math.abs(number(row.commission)) * rate;
        if (!positions[ticker]) positions[ticker] = { lots: [], currency };
        if (!Object.hasOwn(realized, ticker)) realized[ticker] = 0;
        positions[ticker].currency = currency;

        if (String(row.action || '').toUpperCase() === 'BUY') {
          if (qty > 0) {
            positions[ticker].lots.push({
              qty,
              cost: qty * priceSgd + commissionSgd + number(row.cost_basis_adjustment),
            });
          }
          return;
        }

        const availableQty = positions[ticker].lots.reduce((sum, lot) => sum + lot.qty, 0);
        const sellQty = Math.min(qty, Math.max(availableQty, 0));
        const allocatedCommission = qty > 0 ? commissionSgd * (sellQty / qty) : 0;
        let remaining = sellQty;
        let removedCost = 0;
        while (remaining > 0.0000001 && positions[ticker].lots.length) {
          const lot = positions[ticker].lots[0];
          const consumed = Math.min(remaining, lot.qty);
          const unitCost = lot.qty > 0 ? lot.cost / lot.qty : 0;
          removedCost += consumed * unitCost;
          lot.qty -= consumed;
          lot.cost -= consumed * unitCost;
          remaining -= consumed;
          if (lot.qty < 0.0000001) positions[ticker].lots.shift();
        }
        realized[ticker] += sellQty * priceSgd - allocatedCommission - removedCost;
      });

    const holdings = [];
    const realRows = [];
    Object.entries(positions).forEach(([ticker, position]) => {
      const quantity = position.lots.reduce((sum, lot) => sum + lot.qty, 0);
      const cost = position.lots.reduce((sum, lot) => sum + lot.cost, 0);
      const averageCost = quantity > 0 ? cost / quantity : 0;
      if (quantity > 0.0001) {
        holdings.push({
          ticker,
          qty: quantity,
          currency: position.currency || 'SGD',
          avg_cost: averageCost,
          cost_basis: cost,
          realized_pnl: realized[ticker] || 0,
        });
      }
      if (realized[ticker]) realRows.push({ ticker, realized_pnl: realized[ticker], open_qty: quantity });
    });
    return { holdings, realRows };
  }

  function computeConsolidatedHoldings(transactions, profiles, rateResolver) {
    const allowed = new Set((profiles || []).map(profile => String(profile)));
    const grouped = new Map();
    (transactions || []).forEach(row => {
      const profile = String(row.profile || '');
      if (!allowed.has(profile)) return;
      if (!grouped.has(profile)) grouped.set(profile, []);
      grouped.get(profile).push(row);
    });

    const holdingsByTicker = new Map();
    const realizedByTicker = new Map();
    grouped.forEach(rows => {
      const account = computeHoldings(rows, rateResolver);
      account.holdings.forEach(holding => {
        const current = holdingsByTicker.get(holding.ticker) || {
          ticker: holding.ticker, qty: 0, cost_basis: 0, realized_pnl: 0,
          currencies: new Set(),
        };
        current.qty += holding.qty;
        current.cost_basis += holding.cost_basis;
        current.realized_pnl += holding.realized_pnl || 0;
        current.currencies.add(holding.currency);
        holdingsByTicker.set(holding.ticker, current);
      });
      account.realRows.forEach(row => {
        const current = realizedByTicker.get(row.ticker) || { realized_pnl: 0 };
        current.realized_pnl += row.realized_pnl || 0;
        realizedByTicker.set(row.ticker, current);
      });
    });

    const holdings = [...holdingsByTicker.values()].map(holding => ({
      ticker: holding.ticker,
      qty: holding.qty,
      currency: holding.currencies.size === 1 ? [...holding.currencies][0] : 'MIXED',
      avg_cost: holding.qty > 0 ? holding.cost_basis / holding.qty : 0,
      cost_basis: holding.cost_basis,
      realized_pnl: holding.realized_pnl,
    }));
    const realRows = [...realizedByTicker.entries()].map(([ticker, row]) => ({
      ticker,
      realized_pnl: row.realized_pnl,
      open_qty: holdingsByTicker.get(ticker)?.qty || 0,
    }));
    return { holdings, realRows };
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
      stock_transactions: ['profile', 'ticker', 'date', 'action', 'qty', 'price'],
      stock_tracker_prices: ['profile', 'symbol', 'asof_date'],
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

  return {
    DEFAULT_FX_TO_SGD, DATA_COLLECTION_KEYS, number, latestDatedRow,
    fxRateToSgd, convertToSgd, performanceSeries, chainReturnSeries, investmentReturnSeries,
    computeHoldings, computeConsolidatedHoldings, normalizeDatabase, mergeDatabases,
  };
});
