const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const HOST = '127.0.0.1';
const requestedPort = Number(process.env.PORT);
const PORT = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.STOCK_DATA_DIR ? path.resolve(process.env.STOCK_DATA_DIR) : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const TEMP_FILE = path.join(DATA_DIR, 'data.json.tmp');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const SAMPLE_FILE = path.join(DATA_DIR, 'sample.json');
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

async function ensureDataFile() {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    try {
      await fs.copyFile(SAMPLE_FILE, DATA_FILE);
    } catch {
      const initial = {
        schema_version: 1,
        stock_transactions: [], stock_prices: [], stock_watchlists: [],
        stock_tracker_symbols: [], stock_tracker_prices: [], fx_rates: [],
      };
      await fs.writeFile(DATA_FILE, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
    }
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function saveData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Data must be a JSON object');
  await ensureDataFile();
  await fs.copyFile(DATA_FILE, path.join(BACKUP_DIR, 'latest-before-save.json'));
  const payload = { ...data, schema_version: 1, saved_at: new Date().toISOString() };
  await fs.writeFile(TEMP_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(TEMP_FILE, DATA_FILE);
  return payload.saved_at;
}

async function createBackup() {
  await ensureDataFile();
  const name = `backup_${timestamp()}.json`;
  await fs.copyFile(DATA_FILE, path.join(BACKUP_DIR, name));
  return name;
}

async function fetchQuote(url) {
  const symbol = String(url.searchParams.get('symbol') || '').trim().toUpperCase();
  const token = String(url.searchParams.get('token') || process.env.FINNHUB_API_KEY || '').trim();
  if (!/^[A-Z0-9.:-]{1,24}$/.test(symbol)) throw new Error('Invalid ticker symbol');
  if (!token) throw new Error('Finnhub API key is required');
  const endpoint = new URL('https://finnhub.io/api/v1/quote');
  endpoint.searchParams.set('symbol', symbol);
  endpoint.searchParams.set('token', token);
  const response = await fetch(endpoint, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Finnhub returned ${response.status}`);
  return response.json();
}

async function serveStatic(url, res) {
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  if (pathname.includes('..') || pathname.startsWith('/data/') || pathname.startsWith('/.')) return false;
  const filename = path.join(ROOT, pathname);
  if (!filename.startsWith(ROOT + path.sep)) return false;
  try {
    const body = await fs.readFile(filename);
    const contentType = MIME_TYPES[path.extname(filename)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/data') {
      await ensureDataFile();
      return sendJson(res, 200, JSON.parse(await fs.readFile(DATA_FILE, 'utf8')));
    }
    if (req.method === 'PUT' && url.pathname === '/api/data') {
      const savedAt = await saveData(JSON.parse(await readBody(req)));
      return sendJson(res, 200, { success: true, saved_at: savedAt });
    }
    if (req.method === 'POST' && url.pathname === '/api/backup') {
      return sendJson(res, 201, { success: true, name: await createBackup() });
    }
    if (req.method === 'GET' && url.pathname === '/api/quote') {
      return sendJson(res, 200, await fetchQuote(url));
    }
    if (req.method === 'GET' && await serveStatic(url, res)) return;
    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || 'Unexpected server error' });
  }
});

ensureDataFile().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`Stock Analysis is running at http://${HOST}:${server.address().port}`);
    console.log(`Private data file: ${DATA_FILE}`);
  });
}).catch(error => {
  console.error('Could not initialize the local data file:', error);
  process.exitCode = 1;
});
