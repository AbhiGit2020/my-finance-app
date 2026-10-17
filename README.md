# Portfolio Tracker - Local Development

This branch runs the stock-analysis app locally and stores private data in a JSON file.

The application has four workspaces:

- **Portfolios** - separate accounts for the user and family members, holdings, transactions, and price movement.
- **Analysis** - allocation, concentration, account contribution, returns, and holding momentum.
- **Trend Comparison** - portfolio accounts and individual holdings compared with S&P 500, Gold, Nasdaq 100, and other benchmarks.
- **Watch Lists** - stocks, ETFs, and indexes being monitored outside current holdings.

## Start

Requirements: Node.js 18 or newer.

```bash
npm start
```

Open `http://127.0.0.1:3000`.

## Local Data

- Private app data: `data/data.json`
- Automatic previous-save recovery copy: `data/backups/latest-before-save.json`
- Named backups: `data/backups/backup_*.json`
- Tracked empty schema: `data/sample.json`

Private data, backups, and `.env` are excluded from Git.

To migrate the existing stock data, export a JSON backup from the live app and use **JSON Import** in the local app. The local app creates a safety backup before replacing its data.

## Market Prices

The browser sends quote requests through the local server. On first use, enter the Finnhub API key when prompted. It remains in browser storage and is not committed to Git.

Alternatively, start the server with a `FINNHUB_API_KEY` environment variable for future server-side use.

## Checks

```bash
npm test
node --check server.js
node --check js/store.js
```

The live GitHub Pages app remains on `main`. Local development happens on `local-dev` until it is ready to merge.
