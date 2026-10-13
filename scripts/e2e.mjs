// End-to-end smoke test of the production build in emulated iPhone and iPad
// Safari viewports (Chromium engine, touch enabled). Exercises real touch input
// (CDP touch events), the full game loop, failure, restart and checks for errors.
//
// Usage: npm run build && npm run test:e2e   (optional: node scripts/e2e.mjs dist out-dir)
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/node22/lib/node_modules/playwright');
}
const { chromium, devices } = pw;

const root = resolve(process.argv[2] ?? 'dist');
const outDir = resolve(process.argv[3] ?? 'artifacts/e2e');
await mkdir(outDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = join(root, decodeURIComponent(url.pathname));
  if (url.pathname.endsWith('/')) p = join(p, 'index.html');
  try {
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/index.html`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function touchDrag(page, cdp, from, to, steps = 8) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, id: 1 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function twoFingerTwist(page, cdp, c, radius, angle, steps = 8) {
  const pts = (a) => [
    { x: c.x + Math.cos(a) * radius, y: c.y + Math.sin(a) * radius, id: 1 },
    { x: c.x - Math.cos(a) * radius, y: c.y - Math.sin(a) * radius, id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(0) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts((angle * i) / steps) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

for (const deviceName of ['iPhone 15 Pro', 'iPad Pro 11 landscape']) {
  const tag = deviceName.replace(/\s+/g, '_');
  const context = await browser.newContext({ ...devices[deviceName] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const cdp = await context.newCDPSession(page);
  const t0 = Date.now();
  await page.goto(`${base}?quality=low&seed=4242`);
  await page.waitForFunction(() => window.__rockstack?.phase() === 'title', null, { timeout: 120000 });
  check(`${deviceName}: boots to title`, true, `${((Date.now() - t0) / 1000).toFixed(1)} s (software GL)`);
  await page.screenshot({ path: `${outDir}/${tag}-title.png`, timeout: 120000 });

  await page.tap('#btn-start');
  await page.waitForFunction(() => window.__rockstack.heldReady(), null, { timeout: 60000 });
  check(`${deviceName}: start → aiming with a stone`, (await page.evaluate(() => window.__rockstack.phase())) === 'aiming');

  const vp = page.viewportSize();
  const before = await page.evaluate(() => window.__rockstack.held());
  await touchDrag(page, cdp, { x: vp.width * 0.5, y: vp.height * 0.45 }, { x: vp.width * 0.5 + 60, y: vp.height * 0.45 });
  const afterDrag = await page.evaluate(() => window.__rockstack.held());
  check(`${deviceName}: one-finger drag moves the stone`, Math.hypot(afterDrag.x - before.x, afterDrag.z - before.z) > 0.02, `Δ=${Math.hypot(afterDrag.x - before.x, afterDrag.z - before.z).toFixed(3)} m`);

  await twoFingerTwist(page, cdp, { x: vp.width * 0.5, y: vp.height * 0.45 }, 70, 0.8);
  const afterTwist = await page.evaluate(() => window.__rockstack.held());
  check(`${deviceName}: two-finger twist rotates the stone`, Math.abs(afterTwist.yaw - afterDrag.yaw) > 0.3, `Δyaw=${(afterTwist.yaw - afterDrag.yaw).toFixed(2)} rad`);
  const movedByTwist = Math.hypot(afterTwist.x - afterDrag.x, afterTwist.z - afterDrag.z);
  check(`${deviceName}: twist does not also move the stone`, movedByTwist < 0.005, `Δ=${movedByTwist.toFixed(4)} m`);

  await page.tap('#btn-rot-right');
  await page.waitForTimeout(100);
  const afterBtn = await page.evaluate(() => window.__rockstack.held());
  check(`${deviceName}: rotate button`, Math.abs(afterBtn.yaw - afterTwist.yaw) > 0.1);
  await page.tap('#btn-flip');
  const afterFlip = await page.evaluate(() => window.__rockstack.held());
  check(`${deviceName}: flip button cycles resting pose`, afterFlip.pose !== afterBtn.pose || afterFlip.yaw !== afterBtn.yaw);

  // Centre the stone and place three stones with the real Drop button.
  let placed = 0;
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.__rockstack.setHeld(0, 0));
    await page.waitForTimeout(150);
    await page.tap('#btn-drop');
    await page.waitForFunction(() => window.__rockstack.phase() !== 'settling', null, { timeout: 120000 });
    if ((await page.evaluate(() => window.__rockstack.phase())) !== 'aiming') break;
    placed++;
    await page.waitForFunction(() => window.__rockstack.heldReady(), null, { timeout: 60000 });
  }
  const score = await page.evaluate(() => window.__rockstack.score());
  check(`${deviceName}: centred stones settle and score`, placed === 3 && score > 0, `placed ${placed}, score ${score}`);
  await page.screenshot({ path: `${outDir}/${tag}-tower.png`, timeout: 120000 });

  // Pause / resume
  await page.tap('#btn-pause');
  const paused = await page.evaluate(() => window.__rockstack.paused());
  await page.tap('#btn-resume');
  const resumed = !(await page.evaluate(() => window.__rockstack.paused()));
  check(`${deviceName}: pause and resume`, paused && resumed);

  // Deliberately drop the stone beside the tower → it falls into the stream → game over.
  await page.evaluate(() => window.__rockstack.setHeld(1.12, 0));
  await page.waitForTimeout(150);
  await page.tap('#btn-drop');
  await page.waitForFunction(() => ['collapsing', 'gameover'].includes(window.__rockstack.phase()), null, { timeout: 120000 });
  check(`${deviceName}: a stone in the water is detected as failure`, true);
  await page.waitForFunction(() => window.__rockstack.phase() === 'gameover', null, { timeout: 180000 });
  const overVisible = await page.isVisible('#screen-over');
  check(`${deviceName}: results screen`, overVisible);
  await page.screenshot({ path: `${outDir}/${tag}-gameover.png`, timeout: 120000 });

  await page.tap('#btn-again');
  await page.waitForFunction(() => window.__rockstack.phase() === 'aiming' && window.__rockstack.heldReady(), null, { timeout: 60000 });
  const fresh = await page.evaluate(() => ({ score: window.__rockstack.score(), stones: window.__rockstack.stones() }));
  check(`${deviceName}: instant restart resets the tower`, fresh.score === 0 && fresh.stones === 0);

  const best = await page.evaluate(() => JSON.parse(localStorage.getItem('rockstack.v1') || '{}').bestScore ?? 0);
  check(`${deviceName}: best score persisted`, best >= score, `best ${best}`);

  const scrollY = await page.evaluate(() => window.scrollY + document.documentElement.scrollTop);
  check(`${deviceName}: page never scrolls`, scrollY === 0);
  check(`${deviceName}: no runtime errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
