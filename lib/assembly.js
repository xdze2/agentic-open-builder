// Assembly description -> solved instance poses. Pure JS (no fs, no DOM, no three.js): runs in node and in the browser.
// The vocabulary (world axes, faces, verbs) is documented in VOCABULARY.md. Units: mm, degrees.
//
//   const res = await solve(assemblyJson, loader, { state: {x: 120} });
//   loader = { index(): Promise<libraryIndex>, part(slug): Promise<part.json>, assembly(file): Promise<assemblyJson> }
//   res = { instances: [{name, slug, M}], bom, joints, mounts, warnings, state }
//
// Transforms are flat row-major 4x4 arrays (lib/mat.js). M maps part-local coordinates to world.
import * as m4 from './mat.js';
import { PROFILES, vslotDef, slotsOf, SLOT_LIP } from './vslot_ports.js';

export class AsmError extends Error { constructor(msg) { super(msg); this.name = 'AsmError'; } }
const fail = (msg) => { throw new AsmError(msg); };
const list = (a, max = 40) => (a.length > max ? a.slice(0, max).join(', ') + `, ... (${a.length} in total)` : a.join(', '));
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d + 0;

// ---- world convention ----
export const WORLD = { right: [1, 0, 0], left: [-1, 0, 0], back: [0, 1, 0], front: [0, -1, 0], up: [0, 0, 1], down: [0, 0, -1] };
const AXIS = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };
const worldDir = (w) => WORLD[w] || AXIS[w] || null;

function nearestNames(name, names, n = 4) {
  const lo = name.toLowerCase(), score = (c) => { const l = c.toLowerCase(); return l.includes(lo) || lo.includes(l) ? 0 : [...lo].filter((ch, i) => l[i] === ch).length * -1 + 100; };
  return [...names].sort((a, b) => score(a) - score(b)).slice(0, n);
}

// ---- parts ----
async function resolvePartDef(spec, loader, where) {
  const slug = spec.part;
  if (!slug) fail(`${where}: needs "part": <library slug> | "vslot-<profile>" (+ "length") | "assembly": <file>`);
  if (slug.startsWith('vslot-')) {
    const profile = slug.slice(6);
    if (!PROFILES[profile]) fail(`${where}: unknown V-slot profile '${profile}'. Valid: ${Object.keys(PROFILES).map((p) => 'vslot-' + p).join(', ')}`);
    if (!(spec.length > 0)) fail(`${where}: parametric part '${slug}' needs "length" (mm)`);
    return vslotDef(profile, spec.length);
  }
  const index = await loader.index();
  if (!index.parts.some((p) => p.slug === slug)) fail(`${where}: unknown part '${slug}'. Did you mean: ${list(nearestNames(slug, index.parts.map((p) => p.slug)))}? Library parts: ${list(index.parts.map((p) => p.slug), 60)}. Parametric: ${Object.keys(PROFILES).map((p) => 'vslot-' + p).join(', ')}`);
  return loader.part(slug);
}

const holeLabel = (h) => h.name + (h.alias ? ` (${h.alias})` : '');
const isHolePlate = (def) => Array.isArray(def.holes) && def.holes.length > 0;

/** Port lookup with the extended syntax: `name`, `front:h_x_y` / `back:wheel_1`, `front@x,y` (nearest hole), `<rail port>@d` (d mm along the rail). */
export function findPort(def, name, where = '') {
  const direct = def.ports.find((p) => p.name === name);
  if (direct) return { ...direct };
  const faceT = def.dims ? def.dims[2] : 0;
  const hp = (face, h) => ({ name: `${face}:${h.name}`, origin: [h.x, h.y, face === 'front' ? 0 : faceT], z: [0, 0, face === 'front' ? -1 : 1], x: [1, 0, 0], diameter: h.d, hole: h });
  let mm = /^(front|back):(.+)$/.exec(name);
  if (mm && isHolePlate(def)) {
    const h = def.holes.find((q) => q.name === mm[2] || q.alias === mm[2]);
    if (h) return hp(mm[1], h);
    fail(`${where}unknown hole '${mm[2]}' on part '${def.slug}'. Nearest names: ${list(nearestNames(mm[2], def.holes.map((q) => q.name)))}. Holes (${def.holes.length}): ${list(def.holes.map(holeLabel), 80)}`);
  }
  mm = /^(front|back)@(-?[\d.]+)\s*,\s*(-?[\d.]+)$/.exec(name);
  if (mm && isHolePlate(def)) {
    const [x, y] = [+mm[2], +mm[3]];
    const ranked = def.holes.map((h) => ({ h, d: Math.hypot(h.x - x, h.y - y) })).sort((a, b) => a.d - b.d);
    if (ranked[0].d <= 2.0) return { ...hp(mm[1], ranked[0].h), snapped: ranked[0].d };
    return { name, origin: [x, y, mm[1] === 'front' ? 0 : faceT], z: [0, 0, mm[1] === 'front' ? -1 : 1], x: [1, 0, 0], note: `free point (no hole within 2 mm; nearest ${ranked[0].h.name} at ${ranked[0].d.toFixed(1)} mm)` };
  }
  mm = /^(.+)@(-?[\d.]+)$/.exec(name);
  if (mm) {
    const base = def.ports.find((p) => p.name === mm[1]);
    if (base) return { ...base, name, origin: m4.add(base.origin, m4.scale(base.x, +mm[2])) };
  }
  const names = def.ports.map((p) => p.name);
  fail(`${where}unknown port '${name}' on part '${def.slug}'. Did you mean: ${list(nearestNames(name, names))}? Ports: ${list(names, 80)}` +
    (isHolePlate(def) ? `. Plate holes (${def.holes.length}): address as 'front:<hole>' / 'back:<hole>' (e.g. ${def.holes.find((h) => h.alias)?.alias ? 'back:' + def.holes.find((h) => h.alias).alias : 'back:' + def.holes[0].name}) or by plate-local coordinates 'front@x,y' (nearest hole). Hole names: ${list(def.holes.map(holeLabel), 40)}` : ''));
}
const portFrame = (p) => m4.frame(p.origin, p.x, p.z);

// ---- solver ----
function placeMatrix(place) {
  if (!place) return m4.IDENT();
  let R = m4.IDENT();
  if (place.orient) {
    const z = AXIS[place.orient.z], x = AXIS[place.orient.x];
    if (!z || !x) fail(`place.orient needs {"z": "+X|-X|+Y|-Y|+Z|-Z", "x": ...}; got ${JSON.stringify(place.orient)}`);
    if (Math.abs(m4.dot(z, x)) > 1e-9) fail(`place.orient z and x must be perpendicular, got z=${place.orient.z} x=${place.orient.x}`);
    R = m4.frame([0, 0, 0], x, z);
  }
  return m4.mul(m4.trans(place.pos || [0, 0, 0]), R);
}

async function solveAssembly(asm, loader, ctx, file) {
  const where0 = file ? `[${file}] ` : '';
  const state = { ...(asm.state || {}), ...ctx.state };
  const specs = asm.parts || {};
  if (!Object.keys(specs).length) fail(`${where0}no "parts"`);
  const nodes = new Map(), joints = [], warnings = [], mountInfo = [];
  for (const [name, spec] of Object.entries(specs)) {
    if (/[./:@]/.test(name)) fail(`${where0}instance name '${name}' must not contain . / : @`);
    if (spec.assembly) {
      if (ctx.depth > 4) fail(`${where0}sub-assembly nesting too deep (cycle?)`);
      const sub = await solveAssembly(await loader.assembly(spec.assembly), loader, { ...ctx, state, depth: ctx.depth + 1 }, spec.assembly);
      const inst = new Map(sub.instances.map((i) => [i.name, { def: i.def, slug: i.slug, M: i.M }]));
      nodes.set(name, { name, kind: 'asm', M: null, inst, spec });
      joints.push(...sub.joints); warnings.push(...sub.warnings); mountInfo.push(...sub.mounts.map((m) => ({ ...m, name: `${name}/${m.name}` })));
      for (const k of Object.keys(sub.state)) if (!(k in state)) state[k] = sub.state[k];
    } else {
      const def = await resolvePartDef(spec, loader, `${where0}parts.${name}`);
      nodes.set(name, { name, kind: 'part', M: null, inst: new Map([['', { def, slug: def.slug, M: m4.IDENT() }]]), spec });
    }
  }
  const names = [...nodes.keys()];
  const nodeOf = (n, what) => nodes.get(n) || fail(`${where0}${what}: unknown instance '${n}'. Did you mean: ${list(nearestNames(n, names))}? Instances: ${list(names)}`);

  /** 'inst/path' -> {node, entry} */
  const entryOf = (path, what) => {
    const [nn, ...rest] = path.split('/'), node = nodeOf(nn, what), sub = rest.join('/');
    const entry = node.inst.get(sub);
    if (!entry) fail(`${where0}${what}: '${path}' ${node.kind === 'asm' ? `is not an instance of sub-assembly '${nn}'. Valid: ${list([...node.inst.keys()].map((k) => `${nn}/${k}`), 80)}` : 'is a single part'}`);
    return { node, entry };
  };
  const refOf = (ref, what) => {
    if (typeof ref !== 'string' || !ref.includes('.')) fail(`${where0}${what}: port reference must be "instance.port", got ${JSON.stringify(ref)}`);
    const i = ref.indexOf('.'), path = ref.slice(0, i), pname = ref.slice(i + 1);
    const { node, entry } = entryOf(path, what);
    const port = findPort(entry.def, pname, `${where0}${what}: `);
    return { node, entry, port, local: m4.mul(entry.M, portFrame(port)) };
  };
  const world = (r) => m4.mul(r.node.M, r.local);

  // root
  const rootName = asm.root || names[0];
  const root = nodeOf(rootName, 'root');
  root.M = placeMatrix(asm.place);

  // joints
  const jointShift = (j, what) => {
    if (!j) return [0, 0, 0];
    if (j.type !== 'prismatic') fail(`${where0}${what}: joint type must be 'prismatic'`);
    const k = { x: 0, y: 1, z: 2 }[j.axis];
    if (k === undefined) fail(`${where0}${what}: joint.axis must be x, y or z (axis of the B port frame)`);
    if (!j.state) fail(`${where0}${what}: joint needs "state": <variable name>`);
    let v = state[j.state] ?? j.default ?? (j.range ? j.range[0] : 0);
    if (j.range && (v < j.range[0] || v > j.range[1])) { warnings.push(`${what}: state.${j.state}=${v} outside range [${j.range}], clamped`); v = Math.min(j.range[1], Math.max(j.range[0], v)); }
    if (!joints.some((q) => q.state === j.state)) joints.push({ state: j.state, axis: j.axis, range: j.range || null, value: v, label: j.label || what });
    const s = [0, 0, 0]; s[k] = v; return s;
  };

  const edges = [
    ...(asm.mates || []).map((m, i) => ({ kind: 'mate', m, id: m.name || `mate#${i + 1}` })),
    ...(asm.mounts || []).map((m, i) => ({ kind: 'mount', m, id: m.name || `mount#${i + 1}` })),
  ];
  const generated = []; // {name, slug, def, M}
  const done = new Set();

  const applyMate = (e) => {
    const { m, id } = e;
    const A = refOf(m.a, `${id}.a`), B = refOf(m.b, `${id}.b`);
    const T = m4.mul(m4.trans([...(m.offset || [0, 0, 0])].map((v, i) => v + jointShift(m.joint, id)[i])), m4.rotZ(m.rotate || 0));
    const link = m4.mul(T, m4.ROTX180);
    if (A.node === B.node) fail(`${where0}${id}: both ports belong to instance '${A.node.name}'`);
    if (A.node.M && B.node.M) {
      const err = m4.len(m4.sub(m4.origin(m4.mul(world(B), link)), m4.origin(world(A))));
      if (err > 0.05) warnings.push(`${id}: closes a loop with ${err.toFixed(2)} mm of misfit (ignored)`);
      return true;
    }
    if (!A.node.M && !B.node.M) return false;
    if (!A.node.M) A.node.M = m4.mul(m4.mul(world(B), link), m4.inv(A.local));
    else B.node.M = m4.mul(m4.mul(world(A), m4.inv(link)), m4.inv(B.local));
    return true;
  };

  const applyMount = async (e) => {
    const { m, id } = e;
    for (const k of ['rail', 'rail_face', 'plate', 'direction']) if (m[k] === undefined) fail(`${where0}${id}: missing "${k}". A mount needs: rail, rail_face, plate, direction (+ overhang or end_a_at, line, fasten)`);
    const beam = nodeOf(m.rail, `${id}.rail`);
    if (beam.kind !== 'part') fail(`${where0}${id}.rail must be a single part (a rail), not a sub-assembly`);
    const { node: pn, entry: pe } = entryOf(m.plate, `${id}.plate`);
    if (!pn.M) return false;
    if (beam.M) fail(`${where0}${id}: rail '${m.rail}' is already placed by another mate; a mount must be the only thing placing it`);
    const pdef = pe.def, t = pdef.dims[2], P = m4.mul(pn.M, pe.M);
    if (pdef.type !== 'plate') fail(`${where0}${id}.plate: '${m.plate}' is a ${pdef.type}, not a plate`);
    const face = m.plate_face || 'front';
    if (!['front', 'back'].includes(face)) fail(`${where0}${id}.plate_face must be 'front' (free face, default) or 'back' (wheel side)`);
    const f0 = face === 'front' ? 0 : t, nf = [0, 0, face === 'front' ? -1 : 1], farZ = face === 'front' ? t : 0, farFace = face === 'front' ? 'back' : 'front';
    // direction: world word | +X.. world axis | +x -x +y -y plate-local
    let d;
    const dirs = String(m.direction);
    if (/^[+-][xy]$/.test(dirs)) d = [dirs[0] === '-' ? -1 : 1, 0, 0], d = dirs[1] === 'x' ? d : [0, d[0], 0];
    else {
      const w = worldDir(dirs);
      if (!w) fail(`${where0}${id}.direction '${dirs}': use a world word (${Object.keys(WORLD).join(', ')}), a world axis (+X..-Z) or a plate-local axis (+x -x +y -y)`);
      const l = m4.vec(m4.inv(P), w);
      if (Math.abs(l[2]) > 0.3) fail(`${where0}${id}.direction '${dirs}' points out of the plate face (plate normal is world ${JSON.stringify(m4.vec(P, [0, 0, 1]).map((v) => round(v, 2)))}). Choose a direction lying in the plate plane.`);
      const ax = Math.abs(l[0]) > Math.abs(l[1]) ? 0 : 1;
      if (Math.abs(l[1 - ax]) > 0.2) fail(`${where0}${id}.direction '${dirs}' is not along a plate axis (plate-local ${JSON.stringify(l.map((v) => round(v, 2)))}); use +x/-x/+y/-y`);
      d = [0, 0, 0]; d[ax] = Math.sign(l[ax]);
    }
    const ax = d[0] !== 0 ? 0 : 1, sg = d[ax], oax = 1 - ax;
    const lo = pdef.bbox.min[ax], hi = pdef.bbox.max[ax], edge = sg > 0 ? hi : -lo; // distance of the edge from the plate centre along d
    const beamDef = beam.inst.get('').def;
    const L = beamDef.dims[2];
    if (beamDef.type !== 'rail') fail(`${where0}${id}.rail: '${m.rail}' is a ${beamDef.type}, not a rail`);
    let sa; // along-d coordinate of end_a, measured from the plate centre
    if (m.end_a_at !== undefined) sa = m.end_a_at;
    else { const ov = m.overhang ?? 0; sa = edge + ov - L; }
    const line = m.line ?? 0;
    const q = [0, 0, f0]; q[ax] = sg * sa; q[oax] = line;
    const slotsN = beamDef.profile ? slotsOf(beamDef.profile, m.rail_face).length : 1;
    const slot = m.slot ?? Math.ceil(slotsN / 2);
    const sp = findPort(beamDef, `${m.rail_face}_slot_${slot}`, `${where0}${id}.rail_face/slot: `);
    const S = portFrame(sp);
    const Bw = m4.mul(P, m4.frame(q, d, nf));
    const off = m.offset || [0, 0, 0];
    beam.M = m4.mul(m4.mul(m4.mul(Bw, m4.trans(off)), m4.ROTX180), m4.inv(S));
    const info = { name: id, rail: m.rail, plate: m.plate, plate_face: face, direction: dirs, end_a_at: round(sa), line, rail_span_on_plate: [round(Math.max(sa, -edge)), round(Math.min(sa + L, edge))], overhang: round(sa + L - edge), fasteners: [] };

    if (m.fasten) {
      const f = m.fasten;
      const count = f.count ?? 2, margin = f.margin ?? 8, minProt = f.min_protrusion ?? 0.8, tol = f.tolerance ?? 0.6;
      const [dmin, dmax] = f.hole_diameter || [4.8, 7.4];
      const index = await loader.index();
      const nutSlug = f.nut || 'tee-nut';
      const nutDef = await resolvePartDef({ part: nutSlug }, loader, `${id}.fasten.nut`);
      const nutT = nutDef.dims[2];
      const stack = t + (off[2] || 0) + SLOT_LIP + nutT; // plate + gap + lip + nut thickness
      // candidate holes: on the slot line, inside the beam span (minus margin), fitting the screw
      const onPlate = (hx, hy) => { const c = [hx, hy]; return { along: sg * (c[ax]) - sa, perp: c[oax] }; };
      const holes = pdef.holes || [];
      const fits = (h) => h.d >= dmin && h.d <= dmax;
      let chosen;
      if (f.holes) {
        chosen = f.holes.map((r) => { const p = findPort(pdef, r.includes(':') || r.includes('@') ? r : `${farFace}:${r}`, `${where0}${id}.fasten.holes: `); return holes.find((h) => `${h.name}` === p.hole?.name) || fail(`${where0}${id}.fasten.holes: '${r}' is not a hole`); });
      } else {
        const elig = holes.filter(fits).map((h) => ({ h, ...onPlate(h.x, h.y) }))
          .filter((o) => Math.abs(o.perp - line) <= tol && o.along >= margin && o.along <= L - margin).sort((a, b) => a.along - b.along);
        if (elig.length < count) {
          const rows = new Map();
          for (const h of holes.filter(fits)) { const o = onPlate(h.x, h.y); if (o.along >= margin && o.along <= L - margin) rows.set(round(o.perp, 1), (rows.get(round(o.perp, 1)) || 0) + 1); }
          const axn = ['x', 'y'];
          fail(`${where0}${id}: ${elig.length === 0 ? 'no hole lines up' : `only ${elig.length} hole(s) line up (need count=${count})`} with the slot line (plate-local ${axn[oax]} = ${line}, direction ${dirs}) between ${round(Math.max(sa + margin, -edge))} and ${round(Math.min(sa + L - margin, edge))} mm along the direction from the plate centre (screw holes d ${dmin}..${dmax}). ` +
            `Plate-local ${axn[oax]} lines that have such holes under the beam: ${rows.size ? [...rows].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${axn[oax]}=${k} (${n})`).join(', ') : 'none (the beam does not cover any hole: change overhang / end_a_at)'}. Tip: set "line" to one of these, or raise overhang so more of the beam lies on the plate.`);
        }
        const pick = count === 1 ? [elig[Math.floor((elig.length - 1) / 2)]] : Array.from({ length: count }, (_, i) => elig[Math.round((i * (elig.length - 1)) / (count - 1))]);
        chosen = pick.map((o) => o.h);
      }
      // screw length from the stack
      const screwPrefix = f.with || 'low-profile-screw-m5';
      const cands = index.parts.filter((p) => p.type === 'screw' && (p.slug === screwPrefix || p.slug.startsWith(screwPrefix + '-')));
      if (!cands.length) fail(`${where0}${id}.fasten.with '${screwPrefix}' matches no screw. Screws: ${list(index.parts.filter((p) => p.type === 'screw').map((p) => p.slug))}`);
      const defs = await Promise.all(cands.map((c) => loader.part(c.slug)));
      const opts = defs.map((sd) => ({ sd, L: sd.dims[2], shank: sd.dims[2] - (sd.headHeight ?? 1.5) })).sort((a, b) => a.L - b.L);
      const ok = opts.find((o) => o.shank - stack >= minProt);
      if (!ok) fail(`${where0}${id}: no '${screwPrefix}' screw is long enough for the stack ${stack.toFixed(1)} mm (plate ${t} + gap ${off[2] || 0} + lip ${SLOT_LIP} + nut ${nutT}) + ${minProt} mm protrusion. Available lengths: ${opts.map((o) => o.L).join(', ')}`);
      info.screw = { slug: ok.sd.slug, length: ok.L, stack: round(stack), protrusion: round(ok.shank - stack, 2), choices: opts.map((o) => o.L) };
      chosen.forEach((h, k) => {
        const o = onPlate(h.x, h.y), at = o.along;
        const hp = findPort(pdef, `${farFace}:${h.name}`);
        const Hw = m4.mul(P, portFrame(hp));
        const sdef = ok.sd, sport = sdef.ports.find((p) => p.name === 'under_head');
        const sM = m4.mul(m4.mul(Hw, m4.ROTX180), m4.inv(portFrame(sport)));
        const lip = findPort(beamDef, `${m.rail_face}_slot_${slot}_lip@${at}`);
        const nport = nutDef.ports.find((p) => p.name === 'face_a');
        const nM = m4.mul(m4.mul(m4.mul(beam.M, portFrame(lip)), m4.ROTX180), m4.inv(portFrame(nport)));
        // check: screw axis passes through the nut centre
        const sc = m4.point(sM, [0, 0, 0]), sz = m4.vec(sM, [0, 0, 1]), nc = m4.point(nM, nutDef.ports.find((p) => p.name === 'center').origin);
        const rel = m4.sub(nc, sc), perp = m4.len(m4.sub(rel, m4.scale(sz, m4.dot(rel, sz))));
        if (perp > 0.05) fail(`${where0}${id}: internal check failed, screw axis misses the nut centre by ${perp.toFixed(2)} mm`);
        generated.push({ name: `${id}/screw_${k + 1}`, slug: sdef.slug, def: sdef, M: sM }, { name: `${id}/nut_${k + 1}`, slug: nutDef.slug, def: nutDef, M: nM });
        info.fasteners.push({ hole: h.name, d: h.d, plate_local: [h.x, h.y], at_mm_from_end_a: round(at) });
      });
    }
    mountInfo.push(info);
    return true;
  };

  // propagate placements until stable
  let progress = true;
  while (progress) {
    progress = false;
    for (const e of edges) {
      if (done.has(e)) continue;
      const ok = e.kind === 'mate' ? applyMate(e) : await applyMount(e);
      if (ok) { done.add(e); progress = true; }
    }
  }
  const lost = [...nodes.values()].filter((n) => !n.M).map((n) => n.name);
  if (lost.length) fail(`${where0}instance(s) not connected to root '${rootName}' by any mate/mount: ${list(lost)}. Add a mate or mount that places them (mates are solved from the root outward).`);
  const pending = edges.filter((e) => !done.has(e));
  if (pending.length) fail(`${where0}unsolved: ${pending.map((e) => e.id).join(', ')}`);

  const instances = [];
  for (const node of nodes.values()) for (const [path, en] of node.inst) instances.push({ name: node.kind === 'asm' ? `${node.name}/${path}` : node.name, slug: en.slug, def: en.def, M: m4.mul(node.M, en.M) });
  instances.push(...generated);
  const seen = new Set();
  for (const i of instances) { if (seen.has(i.name)) fail(`${where0}duplicate instance name '${i.name}'`); seen.add(i.name); }
  return { instances, joints, warnings, mounts: mountInfo, state };
}

export function bomOf(instances) {
  const rows = new Map();
  for (const i of instances) {
    const isRail = i.def.type === 'rail', cut = i.def.length ?? i.def.dims[2];
    const key = isRail ? `${i.slug} x ${cut}` : i.slug;
    const r = rows.get(key) || { key, slug: i.slug, name: i.def.name, type: i.def.type, count: 0, ...(isRail ? { cut_length: cut, profile: i.def.profile, parametric: !!i.def.length } : {}), dims: i.def.dims };
    r.count++; rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => a.type.localeCompare(b.type) || a.key.localeCompare(b.key));
}

export async function solve(asm, loader, opts = {}) {
  const res = await solveAssembly(asm, loader, { state: opts.state || {}, depth: 0 }, opts.file);
  return { ...res, bom: bomOf(res.instances) };
}
