// Parametric V-slot generator (simplified profile). Frame matches the library rail frame:
// length along +Z from z=0 (end_a) to z=L (end_b), profile centred on the Z axis, longest side along X.
// Simplified: every 20 mm module has one T-slot per outer side (slot opening 6.2 mm, groove 6.1 mm deep, 1.8 mm lips)
// and a 4.2 mm centre bore. The V-groove chamfers of the real profile and the corner webs are not modelled.
import * as THREE from 'three';

export const PROFILES = { '20x20': [1, 1], '20x40': [2, 1], '20x60': [3, 1] }; // [modules along X, along Y], 20 mm each
const M = 20;
// half notch, (u along the side, v inward), listed in travel order
const NOTCH = [[-3.1, 0], [-3.1, 1.8], [-5.3, 3.2], [-5.3, 4.3], [-3, 6.1], [3, 6.1], [5.3, 4.3], [5.3, 3.2], [3.1, 1.8], [3.1, 0]];

export function vslotShape(profile) {
  const [nx, ny] = PROFILES[profile];
  const W = nx * M, H = ny * M;
  // sides in CCW order: start corner, travel dir, inward dir, length, notch count
  const sides = [
    { p: [-W / 2, -H / 2], d: [1, 0], n: [0, 1], len: W },
    { p: [W / 2, -H / 2], d: [0, 1], n: [-1, 0], len: H },
    { p: [W / 2, H / 2], d: [-1, 0], n: [0, -1], len: W },
    { p: [-W / 2, H / 2], d: [0, -1], n: [1, 0], len: H },
  ];
  const pts = [];
  for (const s of sides) {
    const at = (u, v) => [s.p[0] + s.d[0] * u + s.n[0] * v, s.p[1] + s.d[1] * u + s.n[1] * v];
    pts.push(at(0, 0));
    for (let k = 0; k < s.len / M; k++) for (const [u, v] of NOTCH) pts.push(at(M * (k + 0.5) + u, v));
  }
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const hole = new THREE.Path();
    hole.absarc(-W / 2 + M * (i + 0.5), -H / 2 + M * (j + 0.5), 2.1, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  return { shape, W, H };
}

export function vslotGeometry(profile, length) {
  const { shape } = vslotShape(profile);
  return new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false, curveSegments: 16 });
}

/** part.json-like description of the parametric rail (same schema as library parts) */
export function vslotPart(profile, length) {
  const { W, H } = vslotShape(profile);
  const x = [1, 0, 0];
  return {
    slug: `vslot-${profile}`, name: `V-Slot ${profile} x ${length} (parametric)`, type: 'rail', dims: [W, H, length], parametric: 'vslot',
    transform: { frame: 'length = Z, origin = centre of one end (end_a), longest side = X' },
    ports: [
      { name: 'end_a', origin: [0, 0, 0], z: [0, 0, -1], x },
      { name: 'end_b', origin: [0, 0, length], z: [0, 0, 1], x },
      { name: 'mid', origin: [0, 0, length / 2], z: [0, 0, 1], x, note: 'rail station for a carriage; slide along Z' },
    ],
  };
}
