const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('local server loads, saves, and backs up JSON data', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stock-analysis-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: '0', STOCK_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    child.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start')), 5000);
    child.once('error', reject);
    child.stderr.on('data', chunk => reject(new Error(chunk.toString())));
    child.stdout.on('data', chunk => {
      const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(`http://127.0.0.1:${match[1]}`);
    });
  });

  let response = await fetch(`${baseUrl}/api/data`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.stock_transactions, []);
  assert.deepEqual(data.portfolio_accounts, []);

  data.stock_transactions.push({ txn_id: 'test-1', ticker: 'TEST' });
  response = await fetch(`${baseUrl}/api/data`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/backup`, { method: 'POST' });
  assert.equal(response.status, 201);
  const backup = await response.json();
  assert.match(backup.name, /^backup_.*\.json$/);

  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'data.json'), 'utf8'));
  assert.equal(saved.stock_transactions[0].ticker, 'TEST');
  await fs.access(path.join(dataDir, 'backups', backup.name));
  await fs.access(path.join(dataDir, 'backups', 'latest-before-save.json'));
});
