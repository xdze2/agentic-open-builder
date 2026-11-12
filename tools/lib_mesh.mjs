// Small mesh helpers shared by the library tools. Reads only from models/ (never parts/).
import { NodeIO } from '@gltf-transform/core';
const io = new NodeIO();

/** Load a single-mesh per-part GLB -> {pos: Float32Array, idx: Uint32Array}. */
export async function loadMesh(file) {
  const doc = await io.read(file);
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  return { pos: Float32Array.from(prim.getAttribute('POSITION').getArray()), idx: Uint32Array.from(prim.getIndices().getArray()) };
}

export function bbox(pos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  return { min, max, size: max.map((v, k) => v - min[k]), center: max.map((v, k) => (v + min[k]) / 2) };
}

/**
 * Find circular holes in a flat plate lying in XY (thickness along Z, spanning z in [z0,z1]).
 * Takes the triangles lying on the plane z=zPlane, welds vertices, extracts boundary loops;
 * every loop except the one with the biggest extent (outer outline) is a hole.
 * Returns [{x,y,d,n}] (centre = mean of loop vertices, d = 2*mean radius, n = loop vertex count).
 */
export function findHoles({ pos, idx }, zPlane, tol = 0.02) {
  const q = (v) => Math.round(v / 0.005);
  const vid = new Map(), pts = [];
  const weld = (i) => {
    const k = `${q(pos[3 * i])},${q(pos[3 * i + 1])}`;
    if (!vid.has(k)) { vid.set(k, pts.length); pts.push([pos[3 * i], pos[3 * i + 1]]); }
    return vid.get(k);
  };
  const edges = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if ([a, b, c].some((i) => Math.abs(pos[3 * i + 2] - zPlane) > tol)) continue;
    const w = [weld(a), weld(b), weld(c)];
    for (let e = 0; e < 3; e++) {
      const u = w[e], v = w[(e + 1) % 3];
      if (u === v) continue;
      const k = u < v ? `${u}_${v}` : `${v}_${u}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  const adj = new Map();
  for (const [k, n] of edges) if (n === 1) {
    const [u, v] = k.split('_').map(Number);
    (adj.get(u) || adj.set(u, []).get(u)).push(v);
    (adj.get(v) || adj.set(v, []).get(v)).push(u);
  }
  const seen = new Set(), loops = [];
  for (const s of adj.keys()) {
    if (seen.has(s)) continue;
    const comp = [], stack = [s]; seen.add(s);
    while (stack.length) { const u = stack.pop(); comp.push(u); for (const v of adj.get(u)) if (!seen.has(v)) { seen.add(v); stack.push(v); } }
    const P = comp.map((i) => pts[i]);
    const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
    const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const r = P.reduce((s2, p) => s2 + Math.hypot(p[0] - cx, p[1] - cy), 0) / P.length;
    loops.push({ x: cx, y: cy, d: 2 * r, ext, n: P.length });
  }
  loops.sort((a, b) => b.ext - a.ext);
  return loops.slice(1); // drop outer outline
}

// ---- small linear algebra (3x3 row-major rotation, applied as local = R (p - o)) ----
export const sub = (a, b) => a.map((v, i) => v - b[i]);
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const apply = (R, p) => R.map((row) => dot(row, p));
export const applyT = (R, p) => [0, 1, 2].map((j) => R[0][j] * p[0] + R[1][j] * p[1] + R[2][j] * p[2]); // R^T p
export const r3 = (a) => a.map((v) => Math.round(v * 1000) / 1000 + 0); // +0 turns -0 into 0
