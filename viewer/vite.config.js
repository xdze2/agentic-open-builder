// Serves ../models at /models (dev middleware) and copies it to dist on build.
// Also exposes the folder list as the virtual module "virtual:models".
import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const modelsDir = path.resolve(root, '../models');
const listModels = () =>
  fs.existsSync(modelsDir)
    ? fs.readdirSync(modelsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(modelsDir, d.name, 'assembly.glb')))
        .map((d) => d.name).sort()
    : [];

const MIME = { '.glb': 'model/gltf-binary', '.json': 'application/json' };

function modelsPlugin() {
  const id = 'virtual:models', rid = '\0' + id;
  return {
    name: 'models',
    resolveId: (s) => (s === id ? rid : null),
    load: (s) => (s === rid ? `export default ${JSON.stringify(listModels())};` : null),
    configureServer(server) {
      server.middlewares.use('/models', (req, res, next) => {
        const file = path.join(modelsDir, decodeURIComponent(req.url.split('?')[0]));
        if (!file.startsWith(modelsDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() { // build: copy only what the viewer loads
      const out = path.resolve(root, 'dist/models');
      for (const m of listModels()) {
        fs.mkdirSync(path.join(out, m), { recursive: true });
        for (const f of ['assembly.glb', 'catalog.json'])
          fs.copyFileSync(path.join(modelsDir, m, f), path.join(out, m, f));
      }
    },
  };
}

export default defineConfig({
  root,
  base: './',
  plugins: [modelsPlugin()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
