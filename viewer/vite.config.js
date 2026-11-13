// Serves user_data/{models,library,assemblies} (see lib/paths.js) in dev and copies them to dist on build.
// Also exposes the folder list as the virtual module "virtual:models".
import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, MODELS, LIBRARY, ASSEMBLIES, PROMPTS } from '../lib/paths.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const modelsDir = MODELS;
const listModels = () =>
  fs.existsSync(modelsDir)
    ? fs.readdirSync(modelsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(modelsDir, d.name, 'assembly.glb')))
        .map((d) => d.name).sort()
    : [];

const libDir = LIBRARY;
const asmDir = ASSEMBLIES;
const listAsm = () => (fs.existsSync(asmDir) ? fs.readdirSync(asmDir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort() : []);
const MIME = { '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
// Shoelace icons are fetched at runtime from <base>/shoelace/assets/icons (see setBasePath in main.js)
const slDir = path.resolve(root, '../node_modules/@shoelace-style/shoelace/dist');

// ---- prompt API (dev server only) ----
// POST   /api/shot          body: PNG          -> saves user_data/prompts/_draft/<id>.png, returns {id}
// DELETE /api/shot/<id>                        -> removes that draft
// POST   /api/prompt        body: {md, json, shots: [{id, line}]}
//        -> user_data/prompts/<stamp>/{prompt.md, prompt.json, 1.png, 2.png…} (drafts are copied: the draft stays editable)
//        md contains "{{IMAGES}}", replaced by one line per image: "- <path> — <line>". Returns {dir} (relative to the repo).
const DRAFT = path.join(PROMPTS, '_draft');
const SHOT_ID = /^[a-z0-9]{6,32}$/;
const body = (req, max = 20e6) => new Promise((ok, ko) => {
  const parts = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > max) { ko(new Error('body too large')); req.destroy(); } else parts.push(c); });
  req.on('end', () => ok(Buffer.concat(parts))); req.on('error', ko);
});
const send = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
const stamp = () => { const d = new Date(), p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
function promptApi(server) {
  server.middlewares.use('/api/shot', async (req, res) => {
    try {
      if (req.method === 'POST') {
        const png = await body(req);
        if (png.subarray(1, 4).toString() !== 'PNG') return send(res, 400, { error: 'not a PNG' });
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        fs.mkdirSync(DRAFT, { recursive: true }); fs.writeFileSync(path.join(DRAFT, id + '.png'), png);
        for (const f of fs.readdirSync(DRAFT)) { const fp = path.join(DRAFT, f); if (Date.now() - fs.statSync(fp).mtimeMs > 7 * 864e5) fs.rmSync(fp, { force: true }); } // orphans (draft lost in the browser)
        return send(res, 200, { id });
      }
      if (req.method === 'DELETE') {
        const id = req.url.split('?')[0].replace(/^\//, '');
        if (!SHOT_ID.test(id)) return send(res, 400, { error: 'bad id' });
        fs.rmSync(path.join(DRAFT, id + '.png'), { force: true });
        return send(res, 200, { ok: true });
      }
      send(res, 405, { error: 'method' });
    } catch (e) { send(res, 500, { error: e.message }); }
  });
  server.middlewares.use('/api/prompt', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    try {
      const { md, json, shots = [] } = JSON.parse((await body(req, 2e6)).toString());
      if (typeof md !== 'string') return send(res, 400, { error: 'md missing' });
      for (const s of shots) if (!SHOT_ID.test(s.id) || !fs.existsSync(path.join(DRAFT, s.id + '.png'))) return send(res, 400, { error: `screenshot ${s.id} not found (deleted?)` });
      let name = stamp(), k = 1;
      while (fs.existsSync(path.join(PROMPTS, name))) name = `${stamp()}_${++k}`;
      const dir = path.join(PROMPTS, name), rel = path.relative(ROOT, dir);
      fs.mkdirSync(dir, { recursive: true });
      const lines = shots.map((s, i) => { fs.copyFileSync(path.join(DRAFT, s.id + '.png'), path.join(dir, `${i + 1}.png`)); return `- ${rel}/${i + 1}.png — ${s.line || ''}`; });
      fs.writeFileSync(path.join(dir, 'prompt.md'), md.replace('{{IMAGES}}', lines.join('\n')) + '\n');
      fs.writeFileSync(path.join(dir, 'prompt.json'), JSON.stringify({ ...json, images: shots.map((s, i) => ({ file: `${i + 1}.png`, ...s.meta })) }, null, 2) + '\n');
      send(res, 200, { dir: rel });
    } catch (e) { send(res, 500, { error: e.message }); }
  });
}

function modelsPlugin() {
  const id = 'virtual:models', rid = '\0' + id;
  return {
    name: 'models',
    resolveId: (s) => (s === id ? rid : null),
    load: (s) => (s === rid ? `export default ${JSON.stringify(listModels())};` : null),
    configureServer(server) {
      // assemblies/*.json: served live, list at /assemblies/_list.json, HMR event on save
      server.middlewares.use('/assemblies/_list.json', (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(listAsm())); });
      server.watcher.add(asmDir);
      const changed = (f) => {  if (f.startsWith(asmDir + path.sep) && f.endsWith('.json')) server.ws.send({ type: 'custom', event: 'assemblies-changed', data: { file: path.basename(f) } }); };
      server.watcher.on('change', changed); server.watcher.on('add', changed);
      promptApi(server);
      for (const [url, dir] of [['/shoelace', slDir], ['/models', modelsDir], ['/library', libDir], ['/assemblies', asmDir], ['/prompts', PROMPTS]])
        server.middlewares.use(url, (req, res, next) => {
          const file = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
          if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
          res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
          fs.createReadStream(file).pipe(res);
        });
    },
    closeBundle() { // build: copy only what the viewer loads
      const out = path.resolve(root, 'dist/models');
      fs.cpSync(path.join(slDir, 'assets/icons'), path.resolve(root, 'dist/shoelace/assets/icons'), { recursive: true });
      for (const m of listModels()) {
        fs.mkdirSync(path.join(out, m), { recursive: true });
        for (const f of ['assembly.glb', 'catalog.json', 'thumb.png'])
          if (fs.existsSync(path.join(modelsDir, m, f))) fs.copyFileSync(path.join(modelsDir, m, f), path.join(out, m, f));
      }
      if (fs.existsSync(path.join(asmDir, '_thumbs'))) fs.cpSync(path.join(asmDir, '_thumbs'), path.resolve(root, 'dist/assemblies/_thumbs'), { recursive: true });
      if (fs.existsSync(asmDir)) { const o = path.resolve(root, 'dist/assemblies'); fs.mkdirSync(o, { recursive: true }); for (const f of listAsm()) fs.copyFileSync(path.join(asmDir, f), path.join(o, f)); fs.writeFileSync(path.join(o, '_list.json'), JSON.stringify(listAsm())); }
      if (fs.existsSync(libDir)) fs.cpSync(libDir, path.resolve(root, 'dist/library'), { recursive: true }); // part.glb, part.json, index.json
    },
  };
}

export default defineConfig({
  root,
  base: './',
  plugins: [modelsPlugin()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
