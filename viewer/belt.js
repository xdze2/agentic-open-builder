// Mesh of a parametric belt (lib/belt.js): the centre-line path in the belt-local XY plane, swept with a rectangular section
// (thickness across the path, width along local Z). Flat band, no teeth. Open belts get end caps; their clamp points
// (def.clamps) are drawn as small spheres by beltClamps().
import * as THREE from 'three';

const cache = new Map();
export function beltGeometry(def) {
  const P = def.path, closed = !!def.closed;
  const key = `${def.slug}|${closed}|${P.map((p) => p.map((v) => v.toFixed(2)).join(',')).join(';')}`;
  if (cache.has(key)) return cache.get(key);
  if (cache.size > 200) cache.clear(); // the path changes while a clamped carriage moves
  const n = P.length, h = def.thickness / 2, w = def.width / 2;
  // outward normal at each vertex (right of the travel direction)
  const N = P.map((_, i) => {
    const a = P[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = P[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [dy / l, -dx / l];
  });
  // 4 section corners per vertex: outer top, outer bottom, inner bottom, inner top
  const pos = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = P[i], [nx, ny] = N[i];
    pos.push(x + nx * h, y + ny * h, w, x + nx * h, y + ny * h, -w, x - nx * h, y - ny * h, -w, x - nx * h, y - ny * h, w);
  }
  const idx = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = i * 4, b = ((i + 1) % n) * 4;
    for (let k = 0; k < 4; k++) { const k2 = (k + 1) % 4; idx.push(a + k, a + k2, b + k, b + k, a + k2, b + k2); }
  }
  if (!closed) { const e = (n - 1) * 4; idx.push(0, 3, 1, 1, 3, 2, e, e + 1, e + 3, e + 1, e + 2, e + 3); } // end caps
  let geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo = geo.toNonIndexed(); geo.computeVertexNormals(); geo.computeBoundingBox(); geo.computeBoundingSphere();
  cache.set(key, geo);
  return geo;
}

const clampGeo = new THREE.SphereGeometry(1, 20, 14);
const clampMat = new THREE.MeshStandardMaterial({ color: 0xe23b3b, roughness: 0.5 });
/** (re)place the clamp spheres of an open belt as children of its mesh (belt-local coordinates) */
export function beltClamps(mesh, def) {
  for (const c of mesh.children.filter((o) => o.userData.clamp)) mesh.remove(c);
  for (const [x, y] of def.clamps || []) {
    const s = new THREE.Mesh(clampGeo, clampMat);
    s.scale.setScalar(def.width * 0.6); s.position.set(x, y, 0); s.userData = { clamp: true, name: mesh.userData.name };
    mesh.add(s);
  }
}
