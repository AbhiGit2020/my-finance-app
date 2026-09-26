# My Finance App — GitHub Pages Deployment Guide

## What you have

```
hoku-finance/
├── index.html          ← Dashboard
├── input.html          ← Finance Input (income/outgoing)
├── stocks.html         ← Stock portfolio + Finnhub prices
├── stock_tracker.html  ← Watchlists
├── stock_compare.html  ← Price comparison
├── planning.html       ← Budgets, recurring entries, net worth, retirement, CSV import
├── assets.html         ← Assets / Net Worth
├── css/
│   └── style.css
└── js/
    ├── finance-core.js ← Shared, tested financial calculations
    └── store.js        ← Google Drive persistence and app data access
```

Finance data is stored in `MyFinanceApp/data.json` in the signed-in user's Google Drive. Browser storage contains only UI preferences and the Finnhub API key.

---

## Step 1: Create a GitHub account (if you don't have one)
1. Go to https://github.com and sign up (free)

---

## Step 2: Create a new repository
1. Click **+** → **New repository**
2. Name it: `my-finance-app` (or anything you like)
3. Set to **Public** (required for free GitHub Pages)
4. Click **Create repository**

---

## Step 3: Upload your files
**Option A — via GitHub website (easiest):**
1. Open your repository
2. Click **Add file** → **Upload files**
3. Drag and drop the entire `hoku-finance` folder contents
   - Make sure the folder structure is preserved:
     - `index.html` at the root
     - `css/style.css`
     - `js/store.js`
4. Click **Commit changes**

**Option B — via Git command line:**
```bash
cd hoku-finance
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/my-finance-app.git
git push -u origin main
```

---

## Step 4: Enable GitHub Pages
1. Go to your repository → **Settings** tab
2. Scroll down to **Pages** (in the left sidebar)
3. Under **Source**, select:
   - Branch: `main`
   - Folder: `/ (root)`
4. Click **Save**
5. Wait ~2 minutes

Your app will be live at:
**`https://abhigit2020.github.io/my-finance-app/`**

---

## Step 5: Bookmark it
Bookmark the URL on your laptop and phone. It works in any modern browser.

---

## Updating the app later

When you need to update files:
1. Go to your GitHub repository
2. Click the file you want to update
3. Click the **pencil (edit)** icon
4. Make changes, then **Commit changes**

Or use the **Upload files** button to replace files.

---

## Data backup

Your data is in Google Drive. To back it up:
1. Click the backup button in any page header to create a timestamped copy beside `data.json`.
2. Use **JSON** export to download an offline backup.
3. Use **JSON** import to restore a backup; the app creates a Drive safety backup before replacing the in-memory data.

**Export to Excel** works from any page header too.

---

## Important notes

- **Data is Drive-backed**: Sign in with the same Google account to use the same data on another device.
- **Incognito mode**: localStorage doesn't persist in incognito. Use normal browser windows.
- **Conflict protection**: If another tab or device changes `data.json`, saving is blocked and the local version is stored as a `conflict_local_*.json` file.
- **Privacy**: The public site contains no finance data. Google Drive access is required to load the user's private data file.

---

## Stock prices note

Finnhub quotes are fetched directly from the browser. If a quote fails, use **Manual Price Entry**. The Finnhub key stays in that browser's local storage; saved prices are stored in Drive.

---

## Questions?
- GitHub Pages docs: https://docs.github.com/en/pages
- Issues? The app will show errors in the browser console (F12 → Console tab)
