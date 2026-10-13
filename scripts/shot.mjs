// Quick visual check: serves dist/, opens the game in emulated devices, takes screenshots.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const { chromium, devices } = pw;

const root = resolve(process.argv[2] ?? 'dist');
const outDir = resolve(process.argv[3] ?? 'artifacts/screens');
const deviceName = process.argv[4] ?? 'iPhone 15 Pro';
const steps = Number(process.argv[5] ?? 3);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = join(root, decodeURIComponent(url.pathname));
  if (url.pathname.endsWith('/')) p = join(p, 'index.html');
  try {
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const { mkdir } = await import('node:fs/promises');
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ ...devices[deviceName] });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const q = process.argv[6] ?? '';
await page.goto(`http://localhost:${port}/index.html${q}`);
const tag = deviceName.replace(/\s+/g, '_');
try {
  await page.waitForFunction(() => window.__rockstack && window.__rockstack.phase() === 'title', null, { timeout: 90000 });
  console.log('fps probe', await page.evaluate(() => new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else r(n / 3); }; requestAnimationFrame(f); })));
} catch (e) { console.log('title timeout', logs.join('\n')); }
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
await page.waitForTimeout(1500);
await page.screenshot({ path: `${outDir}/${tag}-1-title.png`, timeout: 180000 });
await page.click('#btn-start');
await page.waitForFunction(() => window.__rockstack.heldReady(), null, { timeout: 60000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${outDir}/${tag}-2-aim.png`, timeout: 180000 });
for (let i = 0; i < steps; i++) {
  await page.evaluate(() => { const g = window.__rockstack; g.drop(); });
  await page.waitForFunction(() => window.__rockstack.phase() !== 'settling', null, { timeout: 60000 });
  const ph = await page.evaluate(() => window.__rockstack.phase());
  if (ph !== 'aiming') break;
  await page.waitForFunction(() => window.__rockstack.heldReady(), null, { timeout: 60000 });
  await page.waitForTimeout(300);
}
await page.waitForTimeout(600);
await page.screenshot({ path: `${outDir}/${tag}-3-tower.png`, timeout: 180000 });
const info = await page.evaluate(() => ({ phase: window.__rockstack.phase(), score: window.__rockstack.score(), level: window.__rockstack.level(), h: window.__rockstack.towerHeight() }));
console.log(JSON.stringify(info));
console.log(logs.filter((l) => !l.includes('deprecated')).slice(0, 30).join('\n'));
await browser.close();
server.close();
