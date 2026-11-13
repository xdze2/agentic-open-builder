#!/usr/bin/env node
// Record a demo animation of prompt editing in the viewer by driving the real UI (mouse, typing) in headless Chrome.
//   node tools/demo_anim.mjs [--out docs/demo] [--url http://host:port] [--chrome /path/to/chrome]
// Writes demo.webm (raw recording), demo.mp4 and demo.gif. --gpu renders with the GPU (much faster than SwiftShader). Needs ffmpeg and user_data/ with the plotter. Never presses Send.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const out = path.resolve(opt('--out', path.join(root, 'docs/demo')));
const W = 1280, H = 780;

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
  args: argv.includes('--gpu') ? ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--hide-scrollbars']
    : ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(out, { recursive: true });
const webm = path.join(out, 'demo.webm');

// A visible cursor (headless Chrome draws none), click ripples and a caption bar, injected in every page load.
const overlay = () => {
  const css = `#demo-cur{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px);
      background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M3 2l7 19 2.5-8L20 10z' fill='white' stroke='black' stroke-width='1.5' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat}
    .demo-ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #e8590c;z-index:2147483646;pointer-events:none;animation:demo-r .5s ease-out forwards}
    @keyframes demo-r{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}
    #demo-cap{position:fixed;left:50%;bottom:150px;transform:translateX(-50%);z-index:2147483645;pointer-events:none;background:rgba(20,24,31,.88);color:#fff;
      font:600 17px/1.3 system-ui,sans-serif;padding:9px 18px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);transition:opacity .3s;white-space:nowrap}
    #demo-cap b{color:#ffa94d;margin-right:8px}`;
  addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style'); st.textContent = css; document.head.append(st);
    const cur = document.createElement('div'); cur.id = 'demo-cur'; document.body.append(cur);
    const cap = document.createElement('div'); cap.id = 'demo-cap'; cap.style.opacity = 0; document.body.append(cap);
    addEventListener('mousemove', (e) => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', (e) => { const r = document.createElement('div'); r.className = 'demo-ripple'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; document.body.append(r); setTimeout(() => r.remove(), 600); }, true);
  });
};

let recorder = null, recStart = 0;
// playback speed per section of the recording: [start s, factor]; slow sections (solver rebuilds) are played faster
const speeds = [[0, 1]];
const speed = (f) => speeds.push([(Date.now() - recStart) / 1000, f]);
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
  await page.evaluateOnNewDocument(overlay);
  await page.evaluateOnNewDocument(() => addEventListener('DOMContentLoaded', () => { // a narrower parts panel: 2 columns of cards, a wider 3D view
    const st = document.createElement('style'); st.textContent = '#browser{width:236px !important}'; document.head.append(st);
  }));

  let mouse = { x: W / 2, y: H / 2 };
  const moveTo = async (x, y, steps = 18) => { await page.mouse.move(x, y, { steps }); mouse = { x, y }; };
  const click = async (x, y) => { await moveTo(x, y); await wait(150); await page.mouse.click(x, y); await wait(250); };
  const clickSel = async (sel) => {
    const b = await page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await click(b.x, b.y);
  };
  const t0 = Date.now();
  const caption = (step, text) => (console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', step, text), page.evaluate((s, t) => { const c = document.getElementById('demo-cap'); c.innerHTML = s ? `<b>${s}</b>${t}` : t; c.style.opacity = t ? 1 : 0; }, step, text));
  const type = async (s) => { await page.keyboard.type(s, { delay: 38 }); };

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
      pts.push({ x: p.x + (ctr.x - p.x) * 0.15, y: p.y + (ctr.y - p.y) * 0.15 });
    }
    return pts.sort((a, b) => Math.hypot(a.x - ctr.x, a.y - ctr.y) - Math.hypot(b.x - ctr.x, b.y - ctr.y));
  }, name);
  /** Find a point where the hover tooltip names the instance without moving the visible cursor there (probe, then glide). */
  const screenOf = async (name) => {
    for (const p of await pointsOf(name)) {
      // ask the viewer's own picking, without a visible mouse move
      if (await page.evaluate((x, y, n) => window.__viewer.build.hitAt(x, y)?.object.userData.name === n, p.x, p.y, name)) return p;
    }
    throw new Error('no visible point on ' + name);
  };
  const clickPart = async (name) => {
    const p = await screenOf(name);
    await moveTo(p.x, p.y, 22); await wait(450); await page.mouse.click(p.x, p.y); await wait(500);
  };
  const toScreen = (xyz) => page.evaluate((xyz) => {
    const v = window.__viewer, c = v.controls.target.clone().set(...xyz).project(v.camera), r = document.querySelector('#canvas canvas').getBoundingClientRect();
    return { x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height };
  }, xyz);
  const caretToEnd = () => page.evaluate(() => {
    const b = document.querySelector('#pr-box'), r = document.createRange(); b.focus();
    r.selectNodeContents(b); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });

  for (let i = 0; ; i++) { // Vite may reload once after its first dependency optimisation
    try { await page.goto(`${base}/#assemblies/plotter.json`, { waitUntil: 'load' }); await page.waitForFunction(() => window.__viewer?.build?.result, { timeout: 60000 }); break; }
    catch (e) { if (i >= 3) throw e; }
  }
  await wait(2500);
  await page.evaluate(() => { // a view where the motor, the rail and the free end of the beam are all visible
    const { camera, controls } = window.__viewer, d = camera.position.distanceTo(controls.target), dir = [0.57, -0.684, 0.456];
    controls.target.set(250, -187.35, 24);
    camera.position.copy(controls.target).add(controls.target.clone().set(...dir).multiplyScalar(d));
    camera.zoom = 1.05; camera.updateProjectionMatrix(); camera.lookAt(controls.target); controls.update();
  });
  await wait(1000);
  await page.mouse.move(mouse.x, mouse.y);

  recorder = await page.screencast({ path: webm });
  recStart = Date.now();
  await wait(300);

  // 1. text + parts clicked in 3D
  await caption('1', 'Type a request, click parts in 3D to insert them');
  await click(W / 2 + 60, H - 45); await page.focus('#pr-box');
  await type('Move the ');
  await clickPart('actuator/motor');
  await type(' to the other end of ');
  await clickPart('actuator/rail');
  await type(', and add a belt tensioner in ');

  // 2. a mark drawn on a frozen screenshot, referenced by its number
  await caption('2', 'Draw on a screenshot, click the mark’s number to insert it');
  const end = await toScreen([241.8, -478.4, 35]);
  await clickSel('#pr-shot');
  await page.waitForSelector('.bar button[data-tool="box"]', { visible: true }); await wait(500);
  await clickSel('.bar button[data-tool="box"]');
  await moveTo(end.x - 55, end.y - 50); await page.mouse.down(); await moveTo(end.x + 55, end.y + 50, 25); await page.mouse.up(); await wait(400);
  await clickSel('.bar button[data-tool="select"]'); await click(W - 420, 220); // deselect: its corner handle covers the badge
  await click(end.x - 55, end.y - 50); await wait(400); // number badge: inserts «box 1» at the caret

  // 3. a library part
  await caption('3', 'Add a library part with its + button');
  await caretToEnd();
  await type(' using the ');
  await page.evaluate(() => document.querySelector('#plist .card[data-id="idler-pulley-plate"]').scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await wait(900);
  await clickSel('#plist .card[data-id="idler-pulley-plate"] .ins'); await wait(300);
  await type('.');
  await wait(800);
  await clickSel('.bar button[data-act="capture"]'); await wait(800); // the screenshot joins the prompt (kept in memory until Send)

  // 4. send (hover only: never sends)
  await caption('4', 'Send to Claude Code: text, parts, 3D points, screenshot');
  const sendAt = () => page.$eval('#pr-send', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  for (let k = 0; k < 4; k++) { // hover only: never sends. The status text next to the buttons comes and goes, so re-aim.
    const p = await sendAt(); if (Math.hypot(p.x - mouse.x, p.y - mouse.y) > 4) await moveTo(p.x, p.y, k ? 8 : 25);
    await wait(800);
  }
  await recorder.stop(); recorder = null;
} finally {
  await recorder?.stop().catch(() => {});
  await browser.close().catch(() => {});
  await server?.close();
}

// encode: an MP4 for the web and a GIF (palette per run, 12 fps, 960 px wide) for the README
const mp4 = path.join(out, 'demo.mp4'), gif = path.join(out, 'demo.gif');
const retime = speeds.map(([a, f], k) => `[0:v]trim=start=${a}${k + 1 < speeds.length ? `:end=${speeds[k + 1][0]}` : ''},setpts=(PTS-STARTPTS)/${f}[s${k}]`).join(';') +
  ';' + speeds.map((_, k) => `[s${k}]`).join('') + `concat=n=${speeds.length}:v=1:a=0,fps=25[v]`;
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
ff('-i', webm, '-filter_complex', retime, '-map', '[v]', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '24', '-movflags', '+faststart', mp4);
ff('-i', mp4, '-vf', 'fps=10,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', gif);
for (const f of [webm, mp4, gif]) console.log(path.relative(process.cwd(), f), (fs.statSync(f).size / 1e6).toFixed(1), 'MB');
process.exit(0);
