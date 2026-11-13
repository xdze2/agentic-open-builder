#!/usr/bin/env node
// Retake the README screenshots by driving the real viewer UI (real mouse clicks and typing) in headless Chrome.
//   node tools/readme_shots.mjs [--out docs/screenshots] [--url http://host:port] [--chrome /path/to/chrome]
// Needs user_data/ with the plotter assembly and the library (see README). Never presses Send.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const out = path.resolve(opt('--out', path.join(root, 'docs/screenshots')));
const W = 1400, H = 860;

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
let server = null, base = opt('--url');
if (!base) {
  const { createServer } = await import('vite');
  const port = await freePort();
  server = await createServer({ configFile: path.join(root, 'viewer/vite.config.js'), logLevel: 'error', server: { port, strictPort: true, host: '127.0.0.1' } });
  await server.listen();
  base = `http://127.0.0.1:${port}`;
}
const browser = await puppeteer.launch({
  executablePath: opt('--chrome', '/usr/bin/google-chrome'), headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(out, { recursive: true });

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const shoot = async (name) => { await wait(400); const f = path.join(out, name); await page.screenshot({ path: f }); console.log(path.relative(process.cwd(), f)); };
  const open = async (hash) => {
    for (let i = 0; ; i++) { // Vite may reload once after its first dependency optimisation
      try { await page.goto(`${base}/#${hash}`, { waitUntil: 'load' }); await page.waitForFunction(() => window.__viewer?.build || window.__viewer?.parts, { timeout: 60000 }); break; }
      catch (e) { if (i >= 3) throw e; }
    }
    await wait(2500);
  };
  /** Screen points of an instance: its vertices projected to the screen, nearest to its centre first. */
  const pointsOf = (name) => page.evaluate((name) => {
    const v = window.__viewer; let mesh = null;
    v.build.group.traverse((o) => { if (!mesh && o.isMesh && o.userData.name === name) mesh = o; });
    if (!mesh) return [];
    const r = document.querySelector('#canvas canvas').getBoundingClientRect(), pos = mesh.geometry.attributes.position;
    const toScreen = (w) => { const c = w.project(v.camera); return { x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height }; };
    const box = new mesh.geometry.boundingBox.constructor().setFromObject(mesh), ctr = toScreen(box.getCenter(box.min.clone()));
    const pts = [], step = Math.max(1, Math.floor(pos.count / 300));
    for (let i = 0; i < pos.count; i += step) {
      const w = box.min.clone().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld), p = toScreen(w);
      // pull the vertex a little toward the centre so the point is on a face, not on a silhouette edge
      pts.push({ x: p.x + (ctr.x - p.x) * 0.15, y: p.y + (ctr.y - p.y) * 0.15 });
    }
    return pts.sort((a, b) => Math.hypot(a.x - ctr.x, a.y - ctr.y) - Math.hypot(b.x - ctr.x, b.y - ctr.y));
  }, name);
  /** A screen point where the hover tooltip names this instance (so a click there picks it). */
  const screenOf = async (name) => {
    for (const p of await pointsOf(name)) {
      await page.mouse.move(p.x, p.y);
      if (await page.$eval('#tip', (t, n) => !t.hidden && t.textContent === n, name)) return p;
    }
    throw new Error('no visible point on ' + name);
  };
  const names = () => page.evaluate(() => { const s = new Set(); window.__viewer.build.group.traverse((o) => o.isMesh && o.userData.name && s.add(o.userData.name)); return [...s]; });
  const clickPart = async (name) => {
    const p = await screenOf(name); await page.mouse.move(p.x - 40, p.y - 30); await page.mouse.move(p.x, p.y, { steps: 8 }); await wait(150); await page.mouse.click(p.x, p.y); await wait(500);
  };
  const type = async (s) => { await page.focus('#pr-box'); await page.keyboard.type(s, { delay: 10 }); };

  // 1. main view: plotter, a part selected, a prompt with chips
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
  await open('assemblies/plotter.json');
  await page.click('[data-zoom="in"]'); await wait(800);
  await page.click('#pr-box');
  await type('Move ');
  await clickPart('actuator/motor');
  await type(' to the other end of ');
  await clickPart('actuator/rail');
  await type(' and add a pen holder on ');
  await clickPart('carriage');
  await type('.');
  await page.mouse.move(W / 2, 120);
  await shoot('viewer-plotter.png');

  // 2. bill of materials
  await page.click('#bt-bom'); await wait(800);
  await shoot('viewer-bom.png');
  await page.click('#bom-close'); await wait(500);

  // 3. parametric rail
  await open('parts/vslot-20x60');
  await page.click('[data-view="iso"]'); await wait(800);
  await page.click('[data-zoom="out"]'); await wait(800);
  await shoot('viewer-rail.png');
} finally {
  await browser.close().catch(() => {});
  await server?.close();
}
process.exit(0);
