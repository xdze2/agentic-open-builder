// Tiny rigid-transform helpers. A transform is a flat row-major 4x4 array (16 numbers); vectors are [x,y,z].
export const IDENT = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a) => scale(a, 1 / len(a));

export function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j]; o[i * 4 + j] = s; }
  return o;
}
/** inverse of a rigid transform (rotation + translation) */
export function inv(m) {
  const o = IDENT();
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 4 + j] = m[j * 4 + i];
  for (let i = 0; i < 3; i++) o[i * 4 + 3] = -(o[i * 4] * m[3] + o[i * 4 + 1] * m[7] + o[i * 4 + 2] * m[11]);
  return o;
}
export const point = (m, p) => [0, 1, 2].map((i) => m[i * 4] * p[0] + m[i * 4 + 1] * p[1] + m[i * 4 + 2] * p[2] + m[i * 4 + 3]);
export const vec = (m, v) => [0, 1, 2].map((i) => m[i * 4] * v[0] + m[i * 4 + 1] * v[1] + m[i * 4 + 2] * v[2]);
export const trans = (t) => { const m = IDENT(); m[3] = t[0]; m[7] = t[1]; m[11] = t[2]; return m; };
export function rotZ(deg) {
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  const m = IDENT(); m[0] = c; m[1] = -s; m[4] = s; m[5] = c; return m;
}
export const ROTX180 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
/** frame matrix: columns x, y = z cross x, z, origin o */
export function frame(o, x, z) {
  const y = cross(z, x);
  return [x[0], y[0], z[0], o[0], x[1], y[1], z[1], o[1], x[2], y[2], z[2], o[2], 0, 0, 0, 1];
}
export const col = (m, j) => [m[j], m[4 + j], m[8 + j]];
export const origin = (m) => [m[3], m[7], m[11]];
export const r2 = (v) => Math.round(v * 100) / 100 + 0;
