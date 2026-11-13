#!/usr/bin/env node
// Record a demo animation of prompt editing in the viewer by driving the real UI (mouse, typing) in headless Chrome.
//   node tools/demo_anim.mjs [--out docs/demo] [--url http://host:port] [--chrome /path/to/chrome]
// Writes demo.webm (raw recording), demo.mp4 and demo.gif. --gpu renders with the GPU (much faster than SwiftShader). 
// The story: the request «Move the motor to the end of the rail with a rotating belt» is typed on the BEFORE plotter (X motor riding on the carriage),
// Send is pressed against a stubbed /api/prompt (nothing is written, nothing reaches Claude Code), then the AFTER plotter is swapped in
// (the viewer live-reloads it) and the carriage is driven along X to show the belt moving it.
// user_data/assemblies/plotter.json is the AFTER file (X axis = actuator_belt_2060_500.json); the BEFORE file is the same with the stock actuator_2060_500.json.
// It is put back as AFTER when the script ends.
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
const plotterFile = path.join(root, 'user_data/assemblies/plotter.json');
const AFTER_ASM = 'actuator_belt_2060_500.json', BEFORE_ASM = 'actuator_2060_500.json';
const after = fs.readFileSync(plotterFile, 'utf8');
if (!after.includes(AFTER_ASM)) throw new Error(`user_data/assemblies/plotter.json must use ${AFTER_ASM} (the finished design)`);
const before = after.replace(`"assembly": "${AFTER_ASM}"`, `"assembly": "${BEFORE_ASM}"`);
if (before === after) throw new Error('could not derive the BEFORE plotter');
const restore = () => fs.writeFileSync(plotterFile, after);
process.on('exit', restore);

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

fs.writeFileSync(plotterFile, before);
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
  // eased glide in small timed steps (about 60 per second), so the cursor looks smooth in the recording
  const moveTo = async (x, y, ms = 600) => {
    const a = mouse, n = Math.max(4, Math.round(ms / 16)), t0 = Date.now();
    for (let i = 1; i <= n; i++) {
      const u = i / n, e = u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u);
      await page.mouse.move(a.x + (x - a.x) * e, a.y + (y - a.y) * e);
      const rest = t0 + (ms * i) / n - Date.now(); if (rest > 0) await wait(rest);
    }
    mouse = { x, y };
  };
  const click = async (x, y) => { await moveTo(x, y); await wait(80); await page.mouse.click(x, y); await wait(150); };
  const clickSel = async (sel) => {
    const b = await page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await click(b.x, b.y);
  };
  const t0 = Date.now();
  const caption = (step, text) => (console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', step, text), page.evaluate((s, t) => { const c = document.getElementById('demo-cap'); c.innerHTML = s ? `<b>${s}</b>${t}` : t; c.style.opacity = t ? 1 : 0; }, step, text));
  const type = async (s) => { await page.keyboard.type(s, { delay: 28 }); };

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
      if (await page.evaluate((x, y, n) => { const b = window.__viewer.build, h = b.hitAt(x, y); return h?.object.userData.name === n && b.selOf(h).ref === n; }, p.x, p.y, name)) return p; // the whole instance, not a hole or port
    }
    throw new Error('no visible point on ' + name);
  };
  const clickPart = async (name) => {
    const p = await screenOf(name);
    await moveTo(p.x, p.y, 700); await wait(250); await page.mouse.click(p.x, p.y); await wait(300);
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
  await type('Move the motor ');
  await clickPart('actuator/motor');
  await type(' to the end of ');
  await clickPart('actuator/rail');
  await type(' with a rotating belt');
  await wait(300);
  await page.evaluate(() => window.__viewer.build.show(null)); // no red selection highlight left on the rail

  // 2. send: hover, then press. /api/prompt is stubbed: nothing is written and nothing reaches Claude Code.
  await caption('2', 'Send to Claude Code: text, parts and exact 3D references');
  await page.setRequestInterception(true);
  page.on('request', (r) => (r.url().endsWith('/api/prompt') && r.method() === 'POST'
    ? r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ dir: 'user_data/prompts/demo' }) })
    : r.continue()));
  const sendAt = () => page.$eval('#pr-send', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  for (let k = 0; k < 2; k++) { // the status text next to the buttons comes and goes, so re-aim
    const p = await sendAt(); if (Math.hypot(p.x - mouse.x, p.y - mouse.y) > 4) await moveTo(p.x, p.y, k ? 150 : 700);
    await wait(450);
  }
  await page.mouse.click(mouse.x, mouse.y); await wait(1100);

  // 3. the result: Claude Code has edited the assembly (here: the AFTER file is swapped in), the viewer live-reloads it
  await caption('3', 'Claude Code edits the assembly: fixed motor, rotating belt');
  const reloads = await page.evaluate(() => window.__viewer.reloads || 0);
  speed(5);
  await wait(300);
  fs.writeFileSync(plotterFile, after);
  await page.waitForFunction((n) => (window.__viewer.reloads || 0) > n, { timeout: 120000 }, reloads);
  await wait(1000);
  speed(1);
  await page.evaluate(() => window.__viewer.build.show(null));
  await page.evaluate(() => { // a view of the whole X axis with the motor at its end and the belt along the rail
    const { camera, controls } = window.__viewer, d = camera.position.distanceTo(controls.target), dir = [0.5, -0.72, 0.55];
    controls.target.set(250, -140, 0);
    camera.position.copy(controls.target).add(controls.target.clone().set(...dir).multiplyScalar(d));
    camera.zoom = 1.0; camera.updateProjectionMatrix(); camera.lookAt(controls.target); controls.update();
  });
  await wait(600);

  // 4. orbit around the assembly: the fixed motor at the rail end and the belt loop
  await caption('4', 'Result: motor fixed at the rail end, belt drives the carriage');
  await page.evaluate(() => new Promise((done) => { // 250 degrees about the vertical axis through the target, a little elevation change
    const { camera, controls } = window.__viewer, c = controls.target.clone(), v0 = camera.position.clone().sub(c);
    const r = Math.hypot(v0.x, v0.y), a0 = Math.atan2(v0.y, v0.x), z0 = v0.z, t0 = performance.now(), T = 9000;
    const tick = (now) => {
      const u = Math.min(1, (now - t0) / T), e = u * u * (3 - 2 * u), a = a0 + e * (250 * Math.PI) / 180;
      camera.position.set(c.x + r * Math.cos(a), c.y + r * Math.sin(a), c.z + z0 * (1 + 0.35 * Math.sin(e * Math.PI)));
      camera.lookAt(c); controls.update();
      u < 1 ? requestAnimationFrame(tick) : done();
    };
    requestAnimationFrame(tick);
  }));
  await wait(500);
  await recorder.stop(); recorder = null;
} finally {
  await recorder?.stop().catch(() => {});
  restore();
  await browser.close().catch(() => {});
  await server?.close();
}

// encode: an MP4 for the web and a GIF (palette per run, 12 fps, 960 px wide) for the README
const mp4 = path.join(out, 'demo.mp4'), gif = path.join(out, 'demo.gif');
const retime = speeds.map(([a, f], k) => `[0:v]trim=start=${a}${k + 1 < speeds.length ? `:end=${speeds[k + 1][0]}` : ''},setpts=(PTS-STARTPTS)/${f}[s${k}]`).join(';') +
  ';' + speeds.map((_, k) => `[s${k}]`).join('') + `concat=n=${speeds.length}:v=1:a=0,fps=25[v]`;
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
ff('-i', webm, '-filter_complex', retime, '-map', '[v]', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '24', '-movflags', '+faststart', mp4);
ff('-i', mp4, '-vf', 'fps=8,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', gif);
for (const f of [webm, mp4, gif]) console.log(path.relative(process.cwd(), f), (fs.statSync(f).size / 1e6).toFixed(1), 'MB');
process.exit(0);
