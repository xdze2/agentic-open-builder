#!/usr/bin/env node
// Usage: node tools/step2glb.mjs <input.step> <outDir>
// STEP -> assembly.glb + catalog.json + parts/<slug>__<n>.glb. Units stay in mm, original (assembly) coordinates.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Document, NodeIO } from '@gltf-transform/core';

const require = createRequire(import.meta.url);
const [,, input, outDir] = process.argv;
if (!input || !outDir) { console.error('usage: step2glb.mjs <input.step> <outDir>'); process.exit(2); }

// Tessellation: deflection = 0.1% of each shape's bbox diagonal (relative), 0.5 rad (~29 deg) angular.
const OPTS = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 };

const buf = fs.readFileSync(input);
const occt = await require('occt-import-js')();
const res = occt.ReadStepFile(new Uint8Array(buf), OPTS);
if (!res.success) throw new Error('occt-import-js failed to read ' + input);
const meshes = res.meshes;

// Fallback names: MANIFOLD_SOLID_BREP names in file order (STEP escapes like \X2\ are not decoded; fine for these files).
const stepNames = [...buf.toString('latin1').matchAll(/MANIFOLD_SOLID_BREP\s*\(\s*'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
// Name resolution per mesh: occt mesh name (product name) > name of the tree node holding exactly that mesh >
// STEP MANIFOLD_SOLID_BREP name by file order (only if solid count matches) > input file basename.
// Trailing " v<N>" version suffixes (added by the CAD exporter on product names) are stripped.
const generic = s => !s || /^(Body|Solid|Document)\d*$/i.test(s);
const clean = s => (s || '').replace(/\s+v\d+$/, '').trim();
const treeName = new Map();
(function walk(n) { if (n.meshes?.length === 1 && !n.children?.length) treeName.set(n.meshes[0], n.name); n.children?.forEach(walk); })(res.root);
const stepOk = stepNames.length === meshes.length;
const src = [];
const names = meshes.map((m, i) => {
  for (const [s, v] of [['occt-mesh', clean(m.name)], ['occt-tree', clean(treeName.get(i))], ['step-order', stepOk ? stepNames[i] : '']])
    if (!generic(v)) { src.push(s); return v; }
  src.push('filename'); return path.basename(input).replace(/\.[^.]+$/, '');
});
console.log(`meshes: ${meshes.length}; STEP solids: ${stepNames.length}; name sources: ` + JSON.stringify(src.reduce((o, k) => (o[k] = (o[k] || 0) + 1, o), {})));

const slug = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'part';

function bbox(pos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  return { min, max, center: min.map((v, k) => (v + max[k]) / 2) };
}
const r3 = a => a.map(v => Math.round(v * 1000) / 1000);

const io = new NodeIO();
function addSolid(doc, scene, buffer, m, name, matCache) {
  const key = (m.color || [0.8, 0.8, 0.8]).map(v => v.toFixed(4)).join(',');
  let mat = matCache.get(key);
  if (!mat) {
    const [r, g, b] = key.split(',').map(Number);
    mat = doc.createMaterial('mat_' + matCache.size).setBaseColorFactor([r, g, b, 1]).setMetallicFactor(0.1).setRoughnessFactor(0.6);
    matCache.set(key, mat);
  }
  const pos = new Float32Array(m.attributes.position.array);
  const prim = doc.createPrimitive().setMaterial(mat)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(m.index.array)).setBuffer(buffer));
  if (m.attributes.normal) prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(m.attributes.normal.array)).setBuffer(buffer));
  const mesh = doc.createMesh(name).addPrimitive(prim);
  const node = doc.createNode(name).setMesh(mesh);
  scene.addChild(node);
}
function newDoc() {
  const doc = new Document(); doc.createBuffer();
  doc.getRoot().getAsset().generator = 'step2glb (occt-import-js); units: millimetres';
  return { doc, scene: doc.createScene('assembly'), buffer: doc.getRoot().listBuffers()[0], cache: new Map() };
}

fs.mkdirSync(path.join(outDir, 'parts'), { recursive: true });
const all = newDoc();
const counts = new Map(), catalog = [];
for (let i = 0; i < meshes.length; i++) {
  const m = meshes[i], name = names[i];
  const n = (counts.get(name) || 0) + 1; counts.set(name, n);
  const file = `parts/${slug(name)}__${n}.glb`;
  const bb = bbox(m.attributes.position.array);
  addSolid(all.doc, all.scene, all.buffer, m, `${name}__${n}`, all.cache);
  const one = newDoc();
  addSolid(one.doc, one.scene, one.buffer, m, `${name}__${n}`, one.cache);
  await io.write(path.join(outDir, file), one.doc);
  catalog.push({ index: i, name, instance: n, file, bboxMin: r3(bb.min), bboxMax: r3(bb.max), bboxCenter: r3(bb.center),
    triangles: m.index.array.length / 3, color: (m.color || null) && r3(m.color).map(v => Math.round(v * 1000) / 1000),
    ...(stepNames[i] && stepNames[i] !== name ? { stepSolidName: stepNames[i] } : {}) });
}
await io.write(path.join(outDir, 'assembly.glb'), all.doc);

// Sanity: same-name solids should have equal sorted bbox dimensions (detects name/mesh misordering).
const byName = new Map();
for (const c of catalog) { const d = c.bboxMax.map((v, k) => v - c.bboxMin[k]).sort((a, b) => a - b); (byName.get(c.name) || byName.set(c.name, []).get(c.name)).push(d); }
let bad = 0;
for (const [nm, ds] of byName) for (const d of ds) if (d.some((v, k) => Math.abs(v - ds[0][k]) > 0.02 * Math.max(ds[0][2], 1))) { console.warn(`NOTE: bbox differs among "${nm}" solids (size variants, or name misordering - inspect)`); bad++; break; }

fs.writeFileSync(path.join(outDir, 'catalog.json'), JSON.stringify({
  source: path.basename(input), units: 'mm', tessellation: OPTS, solids: catalog }, null, 1));
console.log(`units: mm (not rescaled; glTF consumers must scale by 0.001 for metres). Wrote ${catalog.length} solids to ${outDir}; bbox-consistency warnings: ${bad}`);
