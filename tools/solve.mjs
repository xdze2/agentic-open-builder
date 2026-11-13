#!/usr/bin/env node
// Usage: node tools/solve.mjs <assembly.json> [--state x=120,y=3] [--json] [--positions]
// Solves an assembly (lib/assembly.js) against user_data/library/ and prints the BOM, joints, mounts and (with --positions) every pose.
// If the file has "compare": {model, anchor}, instance poses are compared with that user_data/models/<model> STEP-derived catalog.
import fs from 'node:fs';
import path from 'node:path';
import { LIBRARY, MODELS } from '../lib/paths.js';
import { solve, AsmError } from '../lib/assembly.js';
import * as m4 from '../lib/mat.js';


const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\w+=/.test(a));
if (!file) { console.error('usage: node tools/solve.mjs <assembly.json> [--state x=120] [--positions] [--json]'); process.exit(2); }
const state = {};
const si = args.indexOf('--state');
if (si >= 0) for (const kv of args[si + 1].split(',')) { const [k, v] = kv.split('='); state[k] = +v; }

const asmDir = path.dirname(path.resolve(file));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const cache = new Map();
export const nodeLoader = {
  index: async () => readJson(path.join(LIBRARY, 'index.json')),
  part: async (slug) => { if (!cache.has(slug)) cache.set(slug, readJson(path.join(LIBRARY, slug, 'part.json'))); return cache.get(slug); },
  assembly: async (f) => readJson(path.join(asmDir, f)),
};

const asm = readJson(path.resolve(file));
let res;
try { res = await solve(asm, nodeLoader, { state, file: path.basename(file) }); }
catch (e) { if (e instanceof AsmError) { console.error('ERROR: ' + e.message); process.exit(1); } throw e; }

if (args.includes('--json')) { console.log(JSON.stringify({ state: res.state, joints: res.joints, mounts: res.mounts, belts: res.belts, bom: res.bom, instances: res.instances.map((i) => ({ name: i.name, slug: i.slug, group: i.group, ...(i.fastener ? { fastener: true } : {}), M: i.M })) })); process.exit(0); }
const f = (v) => v.toFixed(2).padStart(8);
console.log(`${path.basename(file)}: ${res.instances.length} instances`);
console.log(`state: ${JSON.stringify(res.state)}`);
for (const j of res.joints) console.log(`joint ${j.state}: prismatic along ${j.axis}, range ${j.range ? j.range.join('..') : 'free'}, value ${j.value}  (${j.label})`);
for (const w of res.warnings) console.log('WARNING: ' + w);
console.log('\nBOM');
for (const r of res.bom) console.log(`  ${String(r.count).padStart(3)} x ${r.type.padEnd(8)} ${r.cut_length ? `${r.slug}  [rail, cut length ${r.cut_length} mm${r.parametric ? ', parametric' : ', library mesh'}]` : r.belt_length ? `${r.slug}  [belt, ${r.open ? 'cut length' : 'endless loop'} ${r.belt_length} mm, parametric]` : r.slug}`);
for (const m of res.mounts) {
  console.log(`\nmount ${m.name}: rail '${m.rail}' on ${m.plate} (${m.plate_face} face), direction ${m.direction}, line ${m.line}, end_a at ${m.end_a_at}, overhang ${m.overhang} mm, rail on plate over ${m.rail_span_on_plate.join('..')}`);
  if (m.screw) console.log(`  screw ${m.screw.slug} (L ${m.screw.length}, stack ${m.screw.stack}, protrusion ${m.screw.protrusion}; choices ${m.screw.choices.join('/')})`);
  for (const h of m.fasteners) console.log(`  fastener at hole ${h.hole} (d ${h.d}), plate-local (${h.plate_local}), ${h.at_mm_from_end_a} mm from end_a`);
}
for (const b of res.belts || []) {
  console.log(`\nbelt ${b.name}: ${b.part}, ${b.width} mm wide, ${b.open ? 'open, cut length' : 'endless loop'} ${b.length} mm (${b.teeth} teeth)`);
  for (const c of b.clamps || []) console.log(`  clamp at ${c.ref} (${c.offset} mm from the belt line)`);
  for (const p of b.around) console.log(`  around ${p.pulley}: belt radius ${p.radius} mm, wrap ${p.wrap_deg} deg`);
  for (const s of b.spans) console.log(`  span ${s.from} -> ${s.to}: ${s.length} mm`);
}
if (args.includes('--positions')) {
  console.log('\nPOSES (origin xyz, local-x / local-z axes in world)');
  for (const i of res.instances) console.log(`  ${i.name.padEnd(28)} ${m4.origin(i.M).map(f).join(' ')}   x[${m4.col(i.M, 0).map((v) => v.toFixed(2))}] z[${m4.col(i.M, 2).map((v) => v.toFixed(2))}]`);
}

// ---- comparison with the STEP-derived model ----
if (asm.compare) {
  const { model, anchor } = asm.compare;
  const cat = readJson(path.join(MODELS, model, 'catalog.json')).solids;
  const A = res.instances.find((i) => i.name === anchor);
  const T = A.def.transform;
  // world <- STEP:  p_world = M_anchor * R (p_step - origin)
  const R = T.rotation, o = T.origin;
  const W = m4.mul(A.M, [R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1]);
  const Wstep = m4.mul(W, m4.trans(o.map((v) => -v)));
  const stepPoint = (p) => m4.point(Wstep, p);
  const used = new Set();
  const rows = [];
  const aabb = (def, M) => { const { min, max } = def.bbox; const pts = []; for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) pts.push(m4.point(M, [x, y, z])); return [0, 1, 2].map((k) => [Math.min(...pts.map((p) => p[k])), Math.max(...pts.map((p) => p[k]))]); };
  const stepBox = (s) => { const pts = []; for (const x of [s.bboxMin[0], s.bboxMax[0]]) for (const y of [s.bboxMin[1], s.bboxMax[1]]) for (const z of [s.bboxMin[2], s.bboxMax[2]]) pts.push(stepPoint([x, y, z])); return [0, 1, 2].map((k) => [Math.min(...pts.map((p) => p[k])), Math.max(...pts.map((p) => p[k]))]); };
  for (const i of res.instances) {
    if (i.def.derivedFrom) continue; // motor handled below
    const mine = aabb(i.def, i.M);
    const cands = cat.filter((s) => s.name === i.def.name && !used.has(s.index));
    let best = null;
    for (const s of cands) {
      const sb = stepBox(s);
      const dev = Math.max(...[0, 1].flatMap((e) => [0, 1, 2].map((k) => Math.abs(sb[k][e] - mine[k][e]))));
      if (!best || dev < best.dev) best = { s, dev };
    }
    if (best && best.dev < 5) { used.add(best.s.index); rows.push({ name: i.name, step: `${best.s.name} ${best.s.instance}`, dev: best.dev }); }
    else rows.push({ name: i.name, step: best ? `${best.s.name} ${best.s.instance}` : 'no STEP match', dev: best ? best.dev : NaN, bad: true });
  }
  // motor: body is 40 mm here vs 48 mm in the STEP, so compare the shaft tip (STEP shaft points along +X of the STEP file) and the axis
  const mi = res.instances.find((i) => i.def.derivedFrom);
  if (mi) {
    const s = cat.find((q) => /Nema 17 Stepper/.test(q.name));
    const tipStep = stepPoint([s.bboxMax[0], s.bboxCenter[1], s.bboxCenter[2]]);
    const tip = m4.point(mi.M, [0, 0, mi.def.bbox.max[2]]);
    rows.push({ name: mi.name, step: `${s.name} (48 mm body; shaft tip compared)`, dev: m4.len(m4.sub(tip, tipStep)) });
  }
  rows.sort((a, b) => (b.dev || 0) - (a.dev || 0));
  const solids = cat.filter((s) => !used.has(s.index) && !/Nema 17 Stepper/.test(s.name));
  console.log(`\nCOMPARISON with user_data/models/${model} (anchor ${anchor}); deviation = max abs difference of the world AABB faces, mm`);
  for (const r of rows) console.log(`  ${r.name.padEnd(24)} ${Number.isNaN(r.dev) ? '   n/a' : r.dev.toFixed(3).padStart(7)}  ${r.step}${r.bad ? '  <-- MISMATCH' : ''}`);
  const good = rows.filter((r) => !r.bad);
  console.log(`  max deviation over ${good.length} matched instances: ${Math.max(...good.map((r) => r.dev)).toFixed(3)} mm; mean ${(good.reduce((a, r) => a + r.dev, 0) / good.length).toFixed(3)} mm`);
  console.log(`  STEP solids not modelled here (${solids.length}): ${[...new Set(solids.map((s) => s.name))].join(', ')}`);
}
