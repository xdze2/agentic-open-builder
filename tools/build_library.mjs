#!/usr/bin/env node
// Usage: node tools/build_library.mjs        (npm run library)
// models/*/parts/*.glb + catalog.json  ->  library/<slug>/part.glb + part.json, library/index.json
//
// Deduplicates the per-solid meshes into unique part types and re-centres each into a canonical local frame.
// Reads ONLY from models/. Units: mm.
//
// Dedupe key: same name + same type + same shape fingerprint, within 0.15 mm.
//   - axial parts (wheel, pulley, spacer, bearing, shim, nut): [axis length, circumradius about the axis]
//     (rotation invariant: the bbox of a hex nut depends on how it is turned, so bbox dims alone would split it)
//   - everything else: sorted canonical bbox dims.
// Triangle count is NOT part of the key: occt tessellates every instance slightly differently
// (e.g. 504 vs 596 triangles for two identical 11.5 mm screws). It is kept in the sources list.
//
// Canonical frames (local = R (p - origin), right-handed; see FRAME_RULES below, also written in each part.json):
//   wheel/pulley/spacer/bearing/shim/nut : axis = Z, origin = bbox centre. Flanged/headed end toward -Z.
//   screw       : length = Z, origin = bbox centre, head toward -Z (tip toward +Z)
//   plate       : thickness = Z, longest side = X, origin = plate centre on the BACK face (z=0), front face at z=t.
//                 For the gantry plate and motor mount plate the front face is the one the wheels / gantry face
//                 (+X of the actuator_2060_500 assembly), so the two plates share a frame.
//   tee_nut     : like plate
//   motor       : shaft = +Z, origin = centre of the mounting face (z=0); body extends to -Z
//   rail        : length = Z, 60/40 side = X, origin = centre of one end (z in [0, L]); reference mesh only,
//                 real rails are generated parametrically (viewer/vslot.js)
//   block       : longest = Z, then X, origin = bbox centre
// Belts are skipped: they are parametric (loop length depends on the layout).
import fs from 'node:fs';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { loadMesh, bbox, findHoles, sub, dot, cross, apply, applyT, r3 } from './lib_mesh.mjs';

const MODELS = path.resolve('models'), OUT = path.resolve('library');
const TOL = 0.15;
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// name -> type; first match wins
const TYPES = [
  ['belt', /belt/i], ['plate', /plate/i], ['tee_nut', /tee nut/i], ['rail', /linear rail/i], ['block', /block/i],
  ['pulley', /pulley/i], ['wheel', /wheel/i], ['motor', /stepper|nema \d+ .*motor/i], ['screw', /screw/i],
  ['nut', /\bnut\b/i], ['spacer', /spacer/i], ['bearing', /bearing/i], ['shim', /shim/i],
];
const typeOf = (name) => (TYPES.find(([, re]) => re.test(name)) || ['other'])[0];
const AXIAL = new Set(['wheel', 'pulley', 'spacer', 'bearing', 'shim', 'nut']);

const FRAME_RULES = {
  wheel: 'axis = Z, origin = bbox centre', pulley: 'axis = Z, origin = bbox centre, larger-radius end toward -Z',
  spacer: 'axis = Z, origin = bbox centre', bearing: 'axis = Z, origin = bbox centre', shim: 'axis = Z, origin = bbox centre',
  nut: 'axis = Z, origin = bbox centre', screw: 'length = Z, origin = bbox centre, head toward -Z',
  plate: 'thickness = Z, longest side = X, origin = plate centre on back face (z=0), front face at z=thickness',
  tee_nut: 'thickness = Z, longest side = X, origin = centre on back face (z=0)',
  motor: 'shaft = +Z, origin = centre of mounting face (z=0), body toward -Z',
  rail: 'length = Z, longest cross-section side = X, origin = centre of one end',
  block: 'longest = Z, next = X, origin = bbox centre', other: 'identity axes, origin = bbox centre',
};

// Explicit frames for parts where the front face matters (local x / local z given as source axes).
// Only applied when the representative comes from that model.
const OVERRIDES = {
  'v-slot-gantry-plate-20-80mm': { model: 'actuator_2060_500', x: [0, 0, 1], z: [1, 0, 0] },
  'motor-mount-plate-nema-17': { model: 'actuator_2060_500', x: [0, 0, 1], z: [1, 0, 0] },
};

const unit = (i, s = 1) => [0, 1, 2].map((k) => (k === i ? s : 0));
const order = (dims) => [0, 1, 2].sort((a, b) => dims[a] - dims[b]); // axis indices by ascending size

/** radial extent about axis `a` through c, for vertices whose axial coordinate lies in [lo,hi] */
function radial(pos, a, c, lo, hi) {
  const o = [0, 1, 2].filter((k) => k !== a);
  let r = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const t = pos[i + a];
    if (t < lo || t > hi) continue;
    r = Math.max(r, Math.hypot(pos[i + o[0]] - c[o[0]], pos[i + o[1]] - c[o[1]]));
  }
  return r;
}

/** Decide frame {R, origin, note} for one source mesh. */
function frameFor(type, name, model, pos, bb) {
  const ord = order(bb.size);
  let zi, zs = 1, xi, xs = 1, zvec, xvec;
  const ov = OVERRIDES[slug(name)];
  if (ov && ov.model === model) { zvec = ov.z; xvec = ov.x; }
  else {
    if (['screw', 'rail', 'block'].includes(type)) zi = ord[2];
    else if (type === 'motor') zi = [0, 1, 2].find((k) => Math.abs(bb.size[k] - bb.size[(k + 1) % 3]) > 1 && Math.abs(bb.size[k] - bb.size[(k + 2) % 3]) > 1) ?? ord[2];
    else zi = ord[0]; // axial parts and plates: the thinnest dimension
    // x: longest remaining for plate/rail/block/tee, else first remaining
    const rest = [0, 1, 2].filter((k) => k !== zi);
    xi = (['plate', 'tee_nut', 'rail', 'block'].includes(type)) ? rest.sort((a, b) => bb.size[b] - bb.size[a])[0] : rest[0];
    // axial sign: headed/flanged end toward -Z (motor: shaft toward +Z)
    if (AXIAL.has(type) || type === 'screw' || type === 'motor') {
      const L = bb.size[zi], lo = radial(pos, zi, bb.center, bb.min[zi], bb.min[zi] + 0.2 * L), hi = radial(pos, zi, bb.center, bb.max[zi] - 0.2 * L, bb.max[zi]);
      if (Math.abs(lo - hi) > 0.3) zs = type === 'motor' ? (hi < lo ? 1 : -1) : (hi > lo ? -1 : 1); // motor: shaft end is the narrow one
      if (type === 'motor') zs = hi < lo ? 1 : -1;
    }
    zvec = unit(zi, zs); xvec = unit(xi, xs);
  }
  const yvec = cross(zvec, xvec);
  const R = [xvec, yvec, zvec];
  // origin
  const loc = (p) => apply(R, p);
  const lb = (() => { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) { const q = loc([pos[i], pos[i + 1], pos[i + 2]]); for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], q[k]); mx[k] = Math.max(mx[k], q[k]); } }
    return { mn, mx }; })();
  const oc = [(lb.mn[0] + lb.mx[0]) / 2, (lb.mn[1] + lb.mx[1]) / 2, (lb.mn[2] + lb.mx[2]) / 2]; // bbox centre in local-before-shift coords
  let oz = oc[2];
  if (type === 'plate' || type === 'tee_nut') oz = lb.mn[2];
  if (type === 'rail') oz = lb.mn[2];
  if (type === 'motor') { // mounting face = far end of the body: max z of vertices at the body corners (radial > 0.9 * max)
    let maxr = 0; const zv = [];
    for (let i = 0; i < pos.length; i += 3) { const q = loc([pos[i], pos[i + 1], pos[i + 2]]); maxr = Math.max(maxr, Math.hypot(q[0] - oc[0], q[1] - oc[1])); zv.push(q); }
    oz = Math.max(...zv.filter((q) => Math.hypot(q[0] - oc[0], q[1] - oc[1]) > 0.9 * maxr).map((q) => q[2]));
  }
  const oLocal = [oc[0], oc[1], oz];
  const origin = applyT(R, oLocal); // back to source coordinates
  return { R, origin };
}

function toLocal(fr, pos, nrm) {
  const p = new Float32Array(pos.length), n = nrm ? new Float32Array(nrm.length) : null;
  for (let i = 0; i < pos.length; i += 3) {
    const q = apply(fr.R, sub([pos[i], pos[i + 1], pos[i + 2]], fr.origin));
    p.set(q, i);
    if (nrm) n.set(apply(fr.R, [nrm[i], nrm[i + 1], nrm[i + 2]]), i);
  }
  return { p, n };
}

// ---------------- collect ----------------
const io = new NodeIO();
const solids = [];
for (const model of fs.readdirSync(MODELS).sort()) {
  const cf = path.join(MODELS, model, 'catalog.json');
  if (!fs.existsSync(cf)) continue;
  const cat = JSON.parse(fs.readFileSync(cf, 'utf8'));
  for (const s of cat.solids) {
    const file = path.join(MODELS, model, s.file);
    const m = await loadMesh(file);
    const doc = await io.read(file);
    const nrm = doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('NORMAL')?.getArray();
    const type = typeOf(s.name);
    solids.push({ model, single: cat.solids.length === 1, cat: s, type, mesh: m, nrm: nrm && Float32Array.from(nrm) });
  }
}
console.log(`${solids.length} solids in ${new Set(solids.map((s) => s.model)).size} models`);

// ---------------- frames + fingerprints ----------------
const skipped = [];
const groups = [];
for (const s of solids) {
  if (s.type === 'belt') { skipped.push({ name: s.cat.name, model: s.model, reason: 'parametric (belt loop)' }); continue; }
  const bb = bbox(s.mesh.pos);
  s.fr = frameFor(s.type, s.cat.name, s.model, s.mesh.pos, bb);
  const loc = toLocal(s.fr, s.mesh.pos, s.nrm);
  s.loc = loc;
  const lb = bbox(loc.p);
  s.dims = lb.size; s.lbox = lb;
  s.fp = AXIAL.has(s.type)
    ? [lb.size[2], radial(loc.p, 2, lb.center, -1e9, 1e9)]
    : [...lb.size].sort((a, b) => a - b);
  const g = groups.find((g) => g.name === s.cat.name && g.type === s.type && g.fp.every((v, k) => Math.abs(v - s.fp[k]) <= TOL));
  if (g) g.members.push(s); else groups.push({ name: s.cat.name, type: s.type, fp: s.fp, members: [s] });
}

// ---------------- write ----------------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const nameCount = {};
groups.forEach((g) => (nameCount[slug(g.name)] = (nameCount[slug(g.name)] || 0) + 1));
const r1 = (v) => (Math.round(v * 10) / 10).toString().replace('.', '_');

function writeGlb(file, p, n, idx, name) {
  const doc = new Document(); doc.createBuffer(); const buf = doc.getRoot().listBuffers()[0];
  doc.getRoot().getAsset().generator = 'build_library; units: millimetres';
  const mat = doc.createMaterial('mat').setBaseColorFactor([0.8, 0.8, 0.8, 1]).setMetallicFactor(0.1).setRoughnessFactor(0.6);
  const prim = doc.createPrimitive().setMaterial(mat)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(p).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buf));
  if (n) prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(n).setBuffer(buf));
  const mesh = doc.createMesh(name).addPrimitive(prim);
  doc.createScene('part').addChild(doc.createNode(name).setMesh(mesh));
  return io.write(file, doc);
}

const parts = [];
for (const g of groups) {
  // representative: override model > standalone model > most triangles
  const ov = OVERRIDES[slug(g.name)];
  const rep = g.members.find((m) => ov && m.model === ov.model) || g.members.find((m) => m.single) || [...g.members].sort((a, b) => b.cat.triangles - a.cat.triangles)[0];
  const id = nameCount[slug(g.name)] > 1 ? `${slug(g.name)}-${rep.dims.map((v) => r1(v)).join('x')}` : slug(g.name);
  const dir = path.join(OUT, id);
  fs.mkdirSync(dir, { recursive: true });
  await writeGlb(path.join(dir, 'part.glb'), rep.loc.p, rep.loc.n, rep.mesh.idx, id);
  const part = {
    slug: id, name: g.name, type: g.type,
    dims: r3(rep.dims), bbox: { min: r3(rep.lbox.min), max: r3(rep.lbox.max) },
    ...(AXIAL.has(g.type) ? { radius: r3([g.fp[1]])[0] } : {}),
    source: { model: rep.model, node: `${rep.cat.name}__${rep.cat.instance}`, file: rep.cat.file, triangles: rep.cat.triangles },
    transform: { convention: 'local = rotation * (source - origin)', rotation: rep.fr.R.map(r3), origin: r3(rep.fr.origin), frame: FRAME_RULES[g.type] || FRAME_RULES.other },
    instances: g.members.length,
    foundIn: [...new Set(g.members.map((m) => m.model))],
    ...(g.type === 'rail' ? { parametric: 'vslot', note: 'reference mesh at a fixed length; use the parametric V-slot generator' } : {}),
    ports: [],
  };
  parts.push({ part, rep, dir, g });
}

// ---------------- ports ----------------
const byId = Object.fromEntries(parts.map((p) => [p.part.slug, p]));
const find = (re) => parts.find((p) => re.test(p.part.slug));
const port = (name, origin, z, x, extra = {}) => ({ name, origin: r3(origin), z: r3(z), x: r3(x), ...extra });
const FRONT = (t, x, y, extra) => port('', [x, y, t], [0, 0, 1], [1, 0, 0], extra);
const BACK = (x, y, extra) => port('', [x, y, 0], [0, 0, -1], [1, 0, 0], extra);
const named = (n, p) => ({ ...p, name: n });
const validation = [];
const check = (what, got, want, tol) => { const e = Math.hypot(...got.map((v, i) => v - want[i])); validation.push({ check: what, error_mm: +e.toFixed(3), ok: e <= tol }); console.log(`  [${e <= tol ? 'ok' : 'FAIL'}] ${what}: ${e.toFixed(3)} mm`); };

// solid V wheel: both faces at the axle
const wheel = find(/^solid-v-wheel/);
if (wheel) {
  const h = wheel.part.dims[2] / 2;
  wheel.part.ports = [
    port('center', [0, 0, 0], [0, 0, 1], [1, 0, 0], { note: 'axle centre, mid-plane' }),
    port('axle_front', [0, 0, h], [0, 0, 1], [1, 0, 0], { note: '+Z face' }),
    port('axle_back', [0, 0, -h], [0, 0, -1], [1, 0, 0], { note: '-Z face, mates onto a plate wheel_N port (+ spacer standoff)' }),
  ];
}

// NEMA17
const motor = find(/^nema-17/);
if (motor) {
  const m = rep2local(motor);
  const holes = findHoles({ pos: m.p, idx: motor.rep.mesh.idx }, 0).filter((h) => Math.hypot(h.x, h.y) > 5 && h.d < 4);
  const shaftTip = motor.part.bbox.max[2];
  motor.part.ports = [
    port('face', [0, 0, 0], [0, 0, 1], [1, 0, 0], { note: 'mounting face, Z toward the shaft' }),
    port('shaft', [0, 0, shaftTip], [0, 0, 1], [1, 0, 0], { note: 'shaft tip' }),
    ...holes.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x)).map((h, i) => port(`hole_${i + 1}`, [h.x, h.y, 0], [0, 0, 1], [1, 0, 0], { diameter: +h.d.toFixed(2), note: 'M3 mounting hole measured from the mesh' })),
  ];
  console.log(`nema17: shaft tip z=${shaftTip}, ${holes.length} mounting holes at ${holes.map((h) => `(${h.x.toFixed(2)},${h.y.toFixed(2)})`).join(' ')}`);
}
function rep2local(p) { return { p: toLocal(p.rep.fr, p.rep.mesh.pos, null).p }; }

// gantry plate + motor mount plate (both from actuator_2060_500, shared frame: local Z = assembly +X)
const gp = find(/^v-slot-gantry-plate/), mp = find(/^motor-mount-plate-nema-17/);
const act = solids.filter((s) => s.model === 'actuator_2060_500');
const actCentre = (re, n) => { const s = act.find((q) => re.test(q.cat.name) && (n == null || q.cat.instance === n)); return s.cat.bboxCenter; };
if (gp && gp.rep.model === 'actuator_2060_500') {
  const t = gp.part.dims[2];
  const pm = rep2local(gp);
  const holes = findHoles({ pos: pm.p, idx: gp.rep.mesh.idx }, t);
  const toL = (p) => apply(gp.rep.fr.R, sub(p, gp.rep.fr.origin));
  const wheels = act.filter((s) => /Solid V Wheel/.test(s.cat.name));
  const ports = [];
  const wh = wheels.map((w) => ({ w, c: toL(w.cat.bboxCenter) }));
  // quadrant numbering: 1 (+x,+y) 2 (-x,+y) 3 (-x,-y) 4 (+x,-y)
  const quad = (c) => (c[0] > 0 ? (c[1] > 0 ? 1 : 4) : c[1] > 0 ? 2 : 3);
  for (const { w, c } of wh) {
    // nearest measured hole of 5.1 / 7.1 mm: this is the port; the wheel is only used to pick which hole
    const cand = holes.filter((h) => Math.abs(h.d - 5.1) < 0.3 || Math.abs(h.d - 7.1) < 0.3).sort((a, b) => Math.hypot(a.x - c[0], a.y - c[1]) - Math.hypot(b.x - c[0], b.y - c[1]))[0];
    const q = quad(c);
    ports.push(named(`wheel_${q}`, FRONT(t, cand.x, cand.y, { diameter: +cand.d.toFixed(2), eccentric: cand.d > 6, note: 'wheel hole on the wheel-side (front) face; hole centre measured from the mesh' })));
    check(`wheel_${q} hole centre vs wheel axle in actuator (xy)`, [cand.x, cand.y, 0], [c[0], c[1], 0], cand.d > 6 ? 1.0 : 0.1);
    check(`wheel_${q} wheel standoff above front face (z)`, [0, 0, c[2] - 0], [0, 0, t + 7.4 + 5.1], 0.2); // wheel centre height = front + 7.4 gap + half width
  }
  ports.sort((a, b) => a.name.localeCompare(b.name));
  const mpc = toL(actCentre(/Motor Mount Plate/));
  ports.push(
    named('center', FRONT(t, 0, 0, { note: 'plate centre, front (wheel) face' })),
    named('center_back', BACK(0, 0, { note: 'plate centre, back face' })),
    named('motor_mount', BACK(mpc[0], 0, { note: 'where the NEMA17 motor mount plate sits in actuator_2060_500 (back face, plate centre line); measured from the assembly' })),
  );
  gp.part.ports = ports;
  gp.part.ports_validation = validation.slice();
  const rect = ports.filter((p) => p.name.startsWith('wheel_'));
  const xs = rect.map((p) => p.origin[0]), ys = rect.map((p) => p.origin[1]);
  console.log(`gantry plate: wheel rectangle ${(Math.max(...xs) - Math.min(...xs)).toFixed(2)} x ${(Math.max(...ys) - Math.min(...ys)).toFixed(2)} mm`);
  // rail check: rail centre line (assembly) should be the plate centre line, rail face at wheel V-groove side
  const rail = act.find((q) => /Linear Rail/.test(q.cat.name));
  const rc = toL(rail.cat.bboxCenter);
  check('rail centre vs plate centre (xy), actuator', [rc[0], rc[1], 0], [0, 0, 0], 0.1);
  gp.part.ports_validation = validation.slice();

  if (mp) {
    const t2 = mp.part.dims[2];
    const m2 = rep2local(mp);
    const h2 = findHoles({ pos: m2.p, idx: mp.rep.mesh.idx }, t2);
    const mset = h2.filter((h) => h.d > 5 && h.d < 6.5);
    const bore = h2.filter((h) => h.d > 15)[0];
    console.log(`motor mount: ${h2.length} holes; bore ${bore ? `d=${bore.d.toFixed(1)} at (${bore.x.toFixed(2)},${bore.y.toFixed(2)})` : 'none'}; d3 holes: ${mset.map((h) => `(${h.x.toFixed(2)},${h.y.toFixed(2)})`).join(' ')}`);
    const bx = bore ? bore.x : 0, by = bore ? bore.y : 0;
    mp.part.ports = [
      named('to_gantry', FRONT(t2, 0, 0, { note: 'front face centre; mates onto the gantry plate motor_mount port (back face)' })),
      named('motor', BACK(bx, by, { diameter: bore ? +bore.d.toFixed(2) : undefined, note: 'back face, centred on the motor boss bore; mates the NEMA17 face port' })),
    ];
    // cross-checks in actuator: motor shaft axis (assembly) vs bore position; gantry port vs mount plate position
    const motorC = toL(actCentre(/Nema 17 Stepper/)); const mtl = apply(mp.rep.fr.R, sub(act.find((q) => /Nema 17 Stepper/.test(q.cat.name)).cat.bboxCenter, mp.rep.fr.origin));
    check('motor axis vs mount-plate bore (xy)', [mtl[0], mtl[1], 0], [bx, by, 0], 0.1);
    const gpMotor = gp.part.ports.find((p) => p.name === 'motor_mount');
    const mpPlateC = apply(gp.rep.fr.R, sub(actCentre(/Motor Mount Plate/), gp.rep.fr.origin));
    check('motor_mount port vs mount plate centre in gantry frame', [gpMotor.origin[0], gpMotor.origin[1], 0], [mpPlateC[0], mpPlateC[1], 0], 0.1);
    mp.part.ports_validation = validation.filter((v) => /motor/.test(v.check));
  }
}

// NEMA17 40 mm body variant (the user's motor): scale only z < 0 so face, boss, shaft and ports stay unchanged
if (motor) {
  const BODY = 40;
  const src = motor.rep.loc;
  let zmin = Infinity;
  for (let i = 2; i < src.p.length; i += 3) zmin = Math.min(zmin, src.p[i]);
  const bodyLen = -zmin, k = BODY / bodyLen;
  const p = Float32Array.from(src.p);
  for (let i = 2; i < p.length; i += 3) if (p[i] < 0) p[i] *= k;
  // normals: only z is scaled, side faces are vertical (nz = 0) and the end faces are axis-aligned, so they are unchanged
  const lb = bbox(p);
  const part = {
    ...structuredClone(motor.part), slug: 'nema17-40', name: 'NEMA17 Stepper Motor 40mm', type: 'motor',
    dims: r3(lb.size), bbox: { min: r3(lb.min), max: r3(lb.max) },
    derivedFrom: { slug: motor.part.slug, note: `body scaled along Z only for vertices with z < 0 by ${BODY} / ${bodyLen.toFixed(3)} = ${k.toFixed(4)} (body ${bodyLen.toFixed(2)} -> ${BODY} mm); mounting face, boss, shaft and ports unchanged` },
    instances: 0, foundIn: [],
    ports: structuredClone(motor.part.ports),
  };
  const dir = path.join(OUT, part.slug);
  fs.mkdirSync(dir, { recursive: true });
  await writeGlb(path.join(dir, 'part.glb'), p, src.n, motor.rep.mesh.idx, part.slug);
  parts.push({ part, dir });
  console.log(`nema17-40: measured body length ${bodyLen.toFixed(3)} mm, scale ${k.toFixed(4)}, new bbox z ${lb.min[2].toFixed(2)}..${lb.max[2].toFixed(2)}`);
}

// rail: simple end ports
for (const p of parts.filter((q) => q.part.type === 'rail')) {
  const L = p.part.dims[2];
  p.part.ports = [port('end_a', [0, 0, 0], [0, 0, -1], [1, 0, 0]), port('end_b', [0, 0, L], [0, 0, 1], [1, 0, 0])];
}

// ---------------- flush ----------------
for (const { part, dir } of parts) fs.writeFileSync(path.join(dir, 'part.json'), JSON.stringify(part, null, 1));
const index = {
  units: 'mm', generated: 'tools/build_library.mjs', frameRules: FRAME_RULES,
  portConvention: 'port = {name, origin[3], z[3] (out of the mating face), x[3] (reference)}; y = z cross x. All in the part local frame. A mate puts port A on port B with Z axes opposite.',
  parts: parts.map(({ part }) => ({ slug: part.slug, name: part.name, type: part.type, dims: part.dims, instances: part.instances, ports: part.ports.map((p) => p.name), file: `${part.slug}/part.glb` }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
  skipped,
};
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
const types = {}; parts.forEach(({ part }) => (types[part.type] = (types[part.type] || 0) + 1));
console.log(`\n${solids.length} solids -> ${parts.length} unique parts ${JSON.stringify(types)}; skipped ${skipped.length} belts`);
for (const p of index.parts) console.log(`  ${p.type.padEnd(8)} ${p.slug.padEnd(48)} ${p.dims.map((v) => v.toFixed(2)).join(' x ').padEnd(26)} x${p.instances}`);
if (validation.some((v) => !v.ok)) { console.error('VALIDATION FAILED'); process.exit(1); }
