// Reloads produced GLBs and prints node counts / bboxes. Usage: node tools/verify.mjs user_data/models/<dir>...
import fs from 'node:fs'; import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
const io = new NodeIO();
for (const d of process.argv.slice(2)) {
  const cat = JSON.parse(fs.readFileSync(path.join(d, 'catalog.json')));
  const doc = await io.read(path.join(d, 'assembly.glb'));
  const nodes = doc.getRoot().listNodes();
  let ok = nodes.length === cat.solids.length, tri = 0;
  for (const s of cat.solids) { const p = await io.read(path.join(d, s.file)); if (p.getRoot().listNodes().length !== 1) ok = false; }
  for (const n of nodes) { const a = n.getMesh().listPrimitives()[0].getIndices(); tri += a.getCount() / 3; }
  const sz = f => (fs.statSync(path.join(d, f)).size / 1024).toFixed(0) + 'KB';
  const parts = fs.readdirSync(path.join(d, 'parts')).reduce((a, f) => a + fs.statSync(path.join(d, 'parts', f)).size, 0);
  console.log(`${d}: nodes=${nodes.length} catalog=${cat.solids.length} tris=${tri} consistent=${ok} assembly.glb=${sz('assembly.glb')} parts(${cat.solids.length})=${(parts/1024).toFixed(0)}KB`);
}
