# My Finance App — GitHub Pages Deployment Guide

## What you have

```
hoku-finance/
├── index.html          ← Dashboard
├── input.html          ← Finance Input (income/outgoing)
├── investments.html    ← Investment tracker
├── stocks.html         ← Stock portfolio + Yahoo prices
├── assets.html         ← Assets / Net Worth
├── css/
│   └── style.css
└── js/
    └── store.js        ← All data logic (localStorage)
```

All data is stored in your **browser's localStorage** — no server, no database, no cost.

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
**`https://YOUR_USERNAME.github.io/my-finance-app/`**

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

Your data is in your browser's localStorage. To back it up:
1. Click **💾 Backup JSON** in any page header
2. This downloads a `.json` file with ALL your data
3. To restore: currently you'd re-enter data (full import UI can be added later)

**Export to Excel** works from any page header too.

---

## Important notes

- **Data is browser-specific**: Data on your laptop browser is separate from your phone browser. Use **Export Excel / JSON** to move data between devices.
- **Incognito mode**: localStorage doesn't persist in incognito. Use normal browser windows.
- **Clearing browser data**: If you clear site data, your finance data will be deleted. Back up first!
- **No login / no password**: Anyone with your URL can see the app (but not your data — data is in YOUR browser only, not hosted anywhere).

---

## Stock prices note

The Yahoo Finance fetch works directly from your browser. If it fails (CORS or network issue), use the **Manual Price Entry** section to enter prices yourself. Prices are stored locally.

---

## Questions?
- GitHub Pages docs: https://docs.github.com/en/pages
- Issues? The app will show errors in the browser console (F12 → Console tab)
