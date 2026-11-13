// Serves user_data/{models,library,assemblies} (see lib/paths.js) in dev and copies them to dist on build.
// Also exposes the folder list as the virtual module "virtual:models".
import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, LIBRARY, ASSEMBLIES } from '../lib/paths.js';

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
      for (const [url, dir] of [['/shoelace', slDir], ['/models', modelsDir], ['/library', libDir], ['/assemblies', asmDir]])
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
