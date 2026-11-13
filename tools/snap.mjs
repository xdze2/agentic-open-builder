#!/usr/bin/env node
// Headless snapshots of the viewer (system Chrome + puppeteer-core, SwiftShader WebGL). One browser/page for everything.
//   node tools/snap.mjs assemblies/plotter.json --view iso,top,front [--state x=120] [--size 1000x700] [--out snaps]
//   node tools/snap.mjs part <slug> [--view ...]          (slug may be vslot-20x60 for the parametric V-slot)
//   node tools/snap.mjs model <name> [--view ...]
//   node tools/snap.mjs --thumbs [--force]                 256x256 iso thumbnails: library/<slug>/thumb.png, library/_thumbs/vslot-*.png (parametric profiles at 500 mm),
//                                                          assemblies/_thumbs/<name>.png, models/<name>/thumb.png
// Options: --url http://host:port (reuse a running dev server), --no-axes, --no-grid, --chrome /path/to/chrome
// Views: iso top bottom front back right left. Writes PNGs and prints their paths.
// The viewer renders with an orthographic camera, key-light shadows and a ground shadow (viewer/stage.js).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const valueFlags = new Set(['--view', '--state', '--size', '--out', '--url', '--chrome', '--len']);
const pos = argv.filter((a, i) => !a.startsWith('--') && !valueFlags.has(argv[i - 1]));

const views = opt('--view', 'iso').split(',');
const [W, H] = opt('--size', '1000x700').split('x').map(Number);
const state = opt('--state') ? Object.fromEntries(opt('--state').split(',').map((kv) => { const [k, v] = kv.split('='); return [k, +v]; })) : undefined;
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const mtime = (f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0);

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
const cleanup = async () => { await browser.close().catch(() => {}); await server?.close(); };
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  // Vite may reload once after its first dependency optimisation: retry the first navigation.
  for (let i = 0; ; i++) {
    try { await page.goto(`${base}/?snap=1`, { waitUntil: 'load' }); await page.waitForFunction('window.__snapIdle === true', { timeout: 60000 }); break; }
    catch (e) { if (i >= 3) throw e; }
  }
  /** Render one item/view; returns PNG buffer. Waits on window.__snapReady, never on a sleep. */
  async function shot(target, view, o = {}) {
    const err = await page.evaluate((t, v, oo) => window.__snapLoad(t, v, oo), target, view, o);
    await page.waitForFunction('window.__snapReady === true', { timeout: 30000 });
    if (err) console.error(`warning: ${err}`);
    return page.screenshot({ type: 'png' });
  }
  const write = (file, buf) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf); console.log(path.relative(process.cwd(), file) || file); };
  const opts = { axes: !flag('--no-axes'), grid: !flag('--no-grid') };

  if (flag('--thumbs')) {
    await page.setViewport({ width: 256, height: 256, deviceScaleFactor: 1 });
    const force = flag('--force'), items = [];
    const lib = path.join(root, 'library'), idx = readJson(path.join(lib, 'index.json'));
    for (const p of idx.parts) items.push({ t: { kind: 'part', id: p.slug }, out: path.join(lib, p.slug, 'thumb.png'), src: Math.max(mtime(path.join(lib, p.slug, 'part.glb')), mtime(path.join(lib, p.slug, 'part.json'))) });
    const vsrc = Math.max(mtime(path.join(root, 'viewer/vslot.js')), mtime(path.join(root, 'lib/vslot_ports.js')));
    // parametric profile cards (Parts tab, Rails group): rendered at 500 mm
    const { PROFILES } = await import('../lib/vslot_ports.js');
    for (const k of Object.keys(PROFILES)) items.push({ t: { kind: 'part', id: 'vslot-' + k, len: 500 }, out: path.join(lib, '_thumbs', `vslot-${k}.png`), src: vsrc });
    const ad = path.join(root, 'assemblies');
    const afiles = fs.readdirSync(ad).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
    const asrc = Math.max(...afiles.map((f) => mtime(path.join(ad, f))), mtime(path.join(root, 'lib/assembly.js')));
    for (const f of afiles) items.push({ t: { kind: 'asm', id: f }, out: path.join(ad, '_thumbs', f.replace(/\.json$/, '.png')), src: asrc });
    const md = path.join(root, 'models');
    if (fs.existsSync(md)) for (const d of fs.readdirSync(md, { withFileTypes: true })) if (d.isDirectory() && fs.existsSync(path.join(md, d.name, 'assembly.glb')))
      items.push({ t: { kind: 'model', id: d.name }, out: path.join(md, d.name, 'thumb.png'), src: mtime(path.join(md, d.name, 'assembly.glb')) });
    let done = 0, skipped = 0;
    for (const it of items) {
      if (!force && mtime(it.out) > it.src) { skipped++; continue; }
      write(it.out, await shot(it.t, 'iso', { axes: false, grid: false })); done++;
    }
    console.log(`thumbs: ${done} written, ${skipped} up to date`);
  } else {
    let target;
    if (pos[0] === 'part' || pos[0] === 'model') target = { kind: pos[0], id: pos[1], len: opt('--len') ? +opt('--len') : undefined };
    else if (pos[0]) target = { kind: 'asm', id: path.basename(pos[0]), state };
    else { console.error('usage: node tools/snap.mjs <assemblies/x.json> | part <slug> | model <name> | --thumbs  [--view iso,top] [--state x=120] [--size WxH] [--out dir]'); process.exitCode = 2; }
    if (target) {
      const out = path.resolve(opt('--out', path.join(root, 'snaps')));
      const stem = target.kind === 'asm' ? target.id.replace(/\.json$/, '') : `${target.kind}-${target.id}`;
      for (const v of views) write(path.join(out, `${stem}-${v}.png`), await shot(target, v, opts));
    }
  }
  if (errors.length) console.error('page errors:\n  ' + [...new Set(errors)].join('\n  '));
} finally { await cleanup(); }
process.exit(process.exitCode || 0);
