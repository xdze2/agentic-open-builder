// Parametric timing belt: a closed loop wrapped around pulleys lying in one plane. Pure JS (node + browser).
// Used by the `belts` verb in lib/assembly.js; the viewer turns `def.path` into a mesh (viewer/belt.js).
//
// Belt-local frame: the belt plane is z = 0 (z = axis of the first pulley), x points from the first pulley toward the second.
// `path` = belt centre line (closed polyline, counter-clockwise seen from +z), belt cross-section = width (along z) x thickness.

/** Belt catalogue (source parts, sold by length). Slug -> spec. Used as {"part": "<slug>"} in a `belts` entry, and as lib:<slug> chips. */
export const BELTS = {
  'gt2-belt-6mm': { name: 'GT2 timing belt 6 mm', profile: 'GT2', pitch: 2, width: 6, thickness: 1.38, tooth_height: 0.75, material: 'neoprene, glass-fibre tension cords' },
  'gt2-belt-9mm': { name: 'GT2 timing belt 9 mm', profile: 'GT2', pitch: 2, width: 9, thickness: 1.38, tooth_height: 0.75, material: 'neoprene, glass-fibre tension cords' },
  'gt3-belt-9mm': { name: 'GT3 timing belt 9 mm', profile: 'GT3', pitch: 3, width: 9, thickness: 2.41, tooth_height: 1.14, material: 'neoprene, glass-fibre tension cords' },
};
export const isBelt = (slug) => Object.prototype.hasOwnProperty.call(BELTS, slug);

/** part.json-like definition of a belt. Without `path`: a straight piece of `length` mm along +X (part view, thumbnails).
 *  With `path` (belt-local polyline, z = 0 plane): a routed belt. `closed` = endless loop. */
export function beltDef(slug, { length = 200, path = null, closed = false, extra = {} } = {}) {
  const b = BELTS[slug];
  if (!b) throw new Error(`unknown belt '${slug}'. Valid: ${Object.keys(BELTS).join(', ')}`);
  const P = path || [[0, 0], [length, 0]], h = b.thickness / 2;
  const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
  const min = [Math.min(...xs) - h, Math.min(...ys) - h, -b.width / 2], max = [Math.max(...xs) + h, Math.max(...ys) + h, b.width / 2];
  const ends = closed ? [] : [P[0], P[P.length - 1]].map((q, k) => ({ name: k ? 'end_b' : 'end_a', origin: [q[0], q[1], 0], z: [0, 0, 1], x: [1, 0, 0], note: 'belt end (centre line), z across the belt width' }));
  return {
    slug, name: b.name, type: 'belt', parametric: 'belt', ...b, belt: b.profile.toLowerCase(), length, closed, path: P,
    dims: max.map((v, k) => v - min[k]), bbox: { min, max },
    transform: { frame: path ? 'belt plane = z=0, path = belt centre line (polyline)' : 'straight sample: length along +X, width along Z, teeth not modelled' },
    ports: ends, ...extra,
  };
}

/** Where a belt runs on a pulley part: centre-line radius and offset of the belt plane along the pulley axis (from its `center` port).
 *  Timing pulleys: pitch radius (teeth x pitch / 2 pi). Measured on the GT2 20T mesh: flange z -7..-6, teeth (tip r 6.1) -6..+1, hub with grub screws +1..+7
 *  (the part.json frame note 'larger-radius end toward -Z' is misleading), so the belt plane is at -2.5.
 *  Smooth idler pulley: running surface diameter 17.5 mm (measured on the mesh), belt centre line half a thickness outside it, plane at the centre. */
export function beltSeat(def, belt = BELTS['gt2-belt-6mm']) {
  const m = /^gt(\d)-timing-pulley-(\d+)-tooth/.exec(def.slug || '');
  if (m) return { radius: (+m[2] * +m[1]) / (2 * Math.PI), offset: -2.5, source: `${m[2]} teeth x ${m[1]} mm pitch` };
  if (/idler-pulley/.test(def.slug || '')) return { radius: 8.75 + belt.thickness / 2, offset: 0, source: 'running surface d 17.5 mm' };
  return null;
}

/** Closed loop around circles [{c:[x,y], r}] listed in travel order, belt outside every circle (a convex loop).
 *  Returns { length, path:[[x,y]...], spans:[{from, to, length}], wraps:[deg] }. */
export function beltLoop(circles, stepDeg = 4) {
  const n = circles.length;
  if (n < 2) throw new Error('a belt needs at least 2 pulleys');
  // travel counter-clockwise: reverse a clockwise listing (2 pulleys: either way)
  let area = 0;
  for (let i = 0; i < n; i++) { const a = circles[i].c, b = circles[(i + 1) % n].c; area += a[0] * b[1] - b[0] * a[1]; }
  const C = area < 0 ? [...circles].reverse() : circles;
  // outer tangent from A to B on the right of the travel direction: normal nn with nn.(B-A) = rA - rB
  const tang = C.map((A, i) => {
    const B = C[(i + 1) % n], dx = B.c[0] - A.c[0], dy = B.c[1] - A.c[1], d = Math.hypot(dx, dy);
    if (d <= Math.abs(A.r - B.r) + 1e-6) throw new Error('belt: two consecutive pulleys overlap or are nested');
    const phi = Math.atan2(dy, dx), th = Math.acos((A.r - B.r) / d), a = phi - th; // normal angle
    const nn = [Math.cos(a), Math.sin(a)];
    return { a, p: [A.c[0] + A.r * nn[0], A.c[1] + A.r * nn[1]], q: [B.c[0] + B.r * nn[0], B.c[1] + B.r * nn[1]] };
  });
  const path = [], spans = [], wraps = [], mids = [];
  let length = 0;
  for (let i = 0; i < n; i++) {
    const t = tang[i], B = C[(i + 1) % n], tn = tang[(i + 1) % n];
    const sl = Math.hypot(t.q[0] - t.p[0], t.q[1] - t.p[1]);
    spans.push({ from: i, to: (i + 1) % n, length: sl }); length += sl;
    path.push(t.p);
    // arc on B, counter-clockwise from the incoming normal t.a to the outgoing normal tn.a
    let sweep = tn.a - t.a; while (sweep < 0) sweep += 2 * Math.PI; while (sweep >= 2 * Math.PI) sweep -= 2 * Math.PI;
    wraps.push((sweep * 180) / Math.PI); length += B.r * sweep;
    const k = Math.max(1, Math.ceil((sweep * 180) / Math.PI / stepDeg));
    for (let j = 0; j <= k; j++) { const a = t.a + (sweep * j) / k; path.push([B.c[0] + B.r * Math.cos(a), B.c[1] + B.r * Math.sin(a)]); if (j === Math.floor(k / 2)) mids.push(path[path.length - 1]); }
  }
  // wraps[i] belongs to C[i+1]; rotate so wraps[k] is the wrap on C[k]
  wraps.unshift(wraps.pop());
  return { length, path, spans, wraps, mids, reversed: area < 0 };
}

/** Open belt cut from a closed loop `path`: from clamp point A, along the loop, to clamp point B, on the side that wraps every pulley
 *  (`mids`: one point on each pulley arc). A and B are projected on the loop. Returns { path, length, a, b } or throws. */
export function openBelt(path, A, B, mids) {
  const n = path.length;
  const proj = (X) => {
    let best = null;
    for (let i = 0; i < n; i++) {
      const p = path[i], q = path[(i + 1) % n], dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((X[0] - p[0]) * dx + (X[1] - p[1]) * dy) / l2)), Q = [p[0] + t * dx, p[1] + t * dy];
      const d = Math.hypot(X[0] - Q[0], X[1] - Q[1]);
      if (!best || d < best.d) best = { i, t, Q, d };
    }
    return best;
  };
  const a = proj(A), b = proj(B);
  const walk = (s, e) => { // forward along the loop from s to e
    const out = [s.Q];
    if (!(s.i === e.i && s.t <= e.t)) for (let k = (s.i + 1) % n; ; k = (k + 1) % n) { out.push(path[k]); if (k === e.i) break; }
    out.push(e.Q);
    return out;
  };
  const len = (P) => P.slice(1).reduce((acc, p, k) => acc + Math.hypot(p[0] - P[k][0], p[1] - P[k][1]), 0);
  const has = (P, m) => P.some((p) => Math.hypot(p[0] - m[0], p[1] - m[1]) < 1e-6);
  const fwd = walk(a, b), bwd = walk(b, a).reverse();
  const cand = [fwd, bwd].filter((P) => mids.every((m) => has(P, m)));
  if (!cand.length) throw new Error('the two clamp points must lie on the same belt span (between the same two pulleys), so that one side of the cut wraps every pulley');
  const P = cand.sort((x, y) => len(x) - len(y))[0];
  return { path: P, length: len(P), a, b };
}
