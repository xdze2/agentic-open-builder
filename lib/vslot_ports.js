// V-slot profile description and port generation. Pure JS, no dependencies: used by node tools and the viewer.
// Frame (same as the library rails): length along +Z from z=0 (end_a) to z=L (end_b), profile centred on the Z axis,
// longest side along X. W = size along X, H = size along Y.
//
// Faces (intrinsic, named by the profile axes):  top = +Y, bottom = -Y, right = +X, left = -X, end_a (z=0), end_b (z=L).
// Every side face has one T-slot per 20 mm module. Slots of a face are numbered 1.. in increasing X (top/bottom) or Y (left/right).
// Face / slot ports: origin on the face surface at end_a (slot centre line), z = outward face normal, x = along the rail (+Z).
// So a position "d mm from end_a" is an offset of d along the port x axis.
// `<face>_slot_<i>_lip` is the underside of the lip, SLOT_LIP mm below the face, with z pointing INTO the profile:
// a tee nut face lies on it.
export const PROFILES = { '20x20': [1, 1], '20x40': [2, 1], '20x60': [3, 1] }; // [modules along X, along Y], 20 mm each
export const MODULE = 20;
export const SLOT_OPENING = 6.2, SLOT_LIP = 1.8, SLOT_DEPTH = 6.1;

export const FACES = {
  top: { n: [0, 1, 0], u: [1, 0, 0] }, bottom: { n: [0, -1, 0], u: [1, 0, 0] },
  right: { n: [1, 0, 0], u: [0, 1, 0] }, left: { n: [-1, 0, 0], u: [0, 1, 0] },
};
export const profileDims = (profile) => { const [nx, ny] = PROFILES[profile]; return [nx * MODULE, ny * MODULE]; };
export const profileOfDims = (w, h) => Object.keys(PROFILES).find((k) => { const [a, b] = profileDims(k); return Math.abs(a - w) < 0.5 && Math.abs(b - h) < 0.5; });

/** slots of one face: [{index, u}] with u = coordinate across the face (centre line) */
export function slotsOf(profile, face) {
  const [W, H] = profileDims(profile);
  const horiz = face === 'top' || face === 'bottom';
  const n = (horiz ? W : H) / MODULE, span = horiz ? W : H;
  return Array.from({ length: n }, (_, i) => ({ index: i + 1, u: -span / 2 + MODULE * (i + 0.5) }));
}

export function vslotPorts(profile, length) {
  if (!PROFILES[profile]) throw new Error(`unknown V-slot profile '${profile}'. Valid: ${Object.keys(PROFILES).join(', ')}`);
  const [W, H] = profileDims(profile);
  const x = [1, 0, 0], ports = [
    { name: 'end_a', origin: [0, 0, 0], z: [0, 0, -1], x },
    { name: 'end_b', origin: [0, 0, length], z: [0, 0, 1], x },
    { name: 'mid', origin: [0, 0, length / 2], z: [0, 0, 1], x, note: 'rail station for a carriage; slide along Z' },
  ];
  for (const [face, { n, u }] of Object.entries(FACES)) {
    const half = (face === 'top' || face === 'bottom' ? H : W) / 2;
    const base = n.map((c) => c * half);
    ports.push({ name: face, origin: base, z: n, x: [0, 0, 1], note: `${face} face, centre at end_a; x runs along the rail` });
    for (const s of slotsOf(profile, face)) {
      const o = base.map((c, k) => c + u[k] * s.u);
      ports.push({ name: `${face}_slot_${s.index}`, origin: o, z: n, x: [0, 0, 1], note: `slot centre line on the ${face} face (u=${s.u} mm); position along the rail = offset x from end_a` });
      ports.push({ name: `${face}_slot_${s.index}_lip`, origin: o.map((c, k) => c - n[k] * SLOT_LIP), z: n.map((c) => -c), x: [0, 0, 1], note: 'underside of the slot lip, z into the profile; a tee nut face lies here' });
    }
  }
  return ports;
}

/** part.json-like definition of a cut-to-length V-slot */
export function vslotDef(profile, length) {
  const [W, H] = profileDims(profile);
  return {
    slug: `vslot-${profile}`, name: `V-Slot ${profile} x ${length} (parametric)`, type: 'rail', dims: [W, H, length],
    bbox: { min: [-W / 2, -H / 2, 0], max: [W / 2, H / 2, length] }, parametric: 'vslot', profile, length,
    transform: { frame: 'length = Z, origin = centre of one end (end_a), longest side = X' },
    ports: vslotPorts(profile, length),
  };
}
