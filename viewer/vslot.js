// Parametric V-slot generator (simplified profile). Frame matches the library rail frame:
// length along +Z from z=0 (end_a) to z=L (end_b), profile centred on the Z axis, longest side along X.
// Simplified: every 20 mm module has one T-slot per outer side (slot opening 6.2 mm, groove 6.1 mm deep, 1.8 mm lips)
// and a 4.2 mm centre bore. The V-groove chamfers of the real profile and the corner webs are not modelled.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PROFILES, vslotDef } from '../lib/vslot_ports.js';

export { PROFILES }; // [modules along X, along Y], 20 mm each; ports/slots live in lib/vslot_ports.js (shared with node)
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

/** part.json-like description of the parametric rail (same schema as library parts; ports incl. faces and slots) */
export const vslotPart = (profile, length) => vslotDef(profile, length);

// ---- real profile: stretch the library STEP rail mesh ----
// The library rails (library/v-slot-<profile>x<L>-linear-rail) share the parametric frame (length +Z from z=0, centred, longest side X) and are pure
// extrusions (vertices only at z=0 and z=Lref, side normals nz=0), so stretching z by L/Lref gives an exact cut of any length with the true V-groove profile.
// Ports / picking come from lib/vslot_ports.js, not from this mesh. vslotGeometry() above is only the fallback for profiles without a library mesh.
let libIdx = null; const refCache = new Map(), cutCache = new Map();
async function refRail(profile) {
  if (!refCache.has(profile)) refCache.set(profile, (async () => {
    libIdx ||= await fetch('library/index.json').then((r) => r.json());
    const re = new RegExp(`^v-slot-${profile}x(\\d+)-linear-rail$`);
    const cands = libIdx.parts.filter((p) => p.type === 'rail' && re.test(p.slug)).map((p) => ({ slug: p.slug, L: +p.slug.match(re)[1] })).sort((a, b) => Math.abs(a.L - 500) - Math.abs(b.L - 500));
    if (!cands.length) return null;
    const g = await new GLTFLoader().loadAsync(`library/${cands[0].slug}/part.glb`);
    let geo = null; g.scene.updateMatrixWorld(true);
    g.scene.traverse((o) => { if (o.isMesh && !geo) { geo = o.geometry.clone(); geo.applyMatrix4(o.matrixWorld); } });
    if (!geo) return null;
    geo.computeBoundingBox();
    return { geo, L: geo.boundingBox.max.z }; // measured: frame check z in [0, L]
  })().catch(() => null));
  return refCache.get(profile);
}
/** geometry of a cut V-slot rail: the real profile when the library has one, else the simplified generated one */
export async function railGeometry(profile, length) {
  const key = `${profile}@${length}`;
  if (!cutCache.has(key)) {
    const ref = await refRail(profile);
    let geo;
    if (ref && Math.abs(ref.geo.boundingBox.min.z) < 1e-3) {
      geo = ref.geo.clone();
      const pos = geo.attributes.position, k = length / ref.L;
      for (let i = 0; i < pos.count; i++) pos.setZ(i, pos.getZ(i) * k);
      pos.needsUpdate = true; geo.computeBoundingBox(); geo.computeBoundingSphere();
    } else geo = vslotGeometry(profile, length);
    cutCache.set(key, geo);
  }
  return cutCache.get(key);
}
