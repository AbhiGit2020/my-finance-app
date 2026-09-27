# Stock Analysis App - Deployment Guide

## Workspaces

The app is intentionally limited to four stock-analysis workspaces:

- `stocks.html` - Portfolio Trackers
- `stock_tracker.html?mode=stocks` - Stock Watchlists
- `stock_tracker.html?mode=funds` - ETF & Index Watch List
- `stock_compare.html` - Trend Comparison

`index.html` redirects to Portfolio Trackers.

## Data

Stock transactions, prices, watchlists, tracked symbols, trend history, and FX rates are stored in `MyFinanceApp/data.json` in the signed-in user's Google Drive. The existing Drive folder name is retained so deployed users keep access to their current stock data.

Retired finance-planning records are not shown or modified by the app. A timestamped Drive backup was created before the stock-only conversion.

Browser storage contains UI preferences and the Finnhub API key. The public GitHub Pages site contains no private user data.

## Deployment

GitHub Pages serves the `main` branch from the repository root:

`https://abhigit2020.github.io/my-finance-app/`

To publish an update:

```bash
git add index.html stocks.html stock_tracker.html stock_compare.html css js test package.json DEPLOY.md
git commit -m "Describe the update"
git push origin main
```

Allow GitHub Pages a few minutes to publish the new commit.

## Backup And Recovery

- Use the header backup action to create a timestamped Drive copy of `data.json`.
- Use JSON export for an offline backup.
- JSON import creates a safety backup before replacing app data.
- The app merges non-overlapping edits when another browser or tab saves first.
- For a failed automatic quote, use Manual Price Entry.

## Verification

Run the automated checks before deploying:

```bash
npm test
node --check js/stock-core.js
node --check js/store.js
```
