import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import modelNames from 'virtual:models';
import { PROFILES, vslotGeometry, vslotPart } from './vslot.js';

const $ = (id) => document.getElementById(id);

// Part type from name. First match wins, so order matters.
const TYPES = [
  ['rail', /v-?slot|rail(?!.*plate)|extrusion/i, 0xb8bcc4],
  ['plate', /plate|mount|bracket/i, 0x4f8fd6],
  ['wheel', /wheel/i, 0xe0883a],
  ['motor', /nema|motor/i, 0x333840],
  ['pulley', /pulley|gear|pinion/i, 0xd4b13a],
  ['belt', /belt/i, 0x15171a],
  ['fastener', /screw|nut|spacer|shim|bearing|washer|bolt/i, 0x8fbf6a],
  ['other', /./, 0xc060b0],
];
const typeOf = (name) => TYPES.find(([, re]) => re.test(name));

// ---- scene ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
$('canvas').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1d22);
const camera = new THREE.PerspectiveCamera(40, 1, 1, 10000);
camera.up.set(0, 0, 1); // Z-up; must be set before OrbitControls is created
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(1, 2, 3);
camera.add(sun); // light follows the camera
scene.add(camera);

const worldAxes = new THREE.AxesHelper(100); // 100 mm
const partAxes = new THREE.AxesHelper(50);
partAxes.visible = false;
scene.add(worldAxes, partAxes);
let grid = null;
let model = null, parts = [], selected = null, catalog = new Map();

const origMat = new WeakMap();
const highlight = new THREE.MeshStandardMaterial({ color: 0xff3366, emissive: 0x661122, roughness: 0.4 });

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// Grid sized to the model, step = power-of-10 mm (1/2/5 steps would be fancier).
function makeGrid(box) {
  if (grid) { scene.remove(grid); grid.geometry.dispose(); }
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z) * 2;
  const step = 10 ** Math.floor(Math.log10(span / 8));
  const n = Math.ceil(span / step / 2) * 2;
  grid = new THREE.GridHelper(n * step, n, 0x777777, 0x3a3d44);
  grid.rotation.x = Math.PI / 2; // XY plane (Z is up in the STEP data)
  grid.position.set(box.getCenter(new THREE.Vector3()).x, box.getCenter(new THREE.Vector3()).y, box.min.z);
  grid.visible = $('t-grid').checked;
  scene.add(grid);
  $('hint').textContent = `Grid: ${step} mm per square, ${n * step} mm wide. Axes: X red, Y green, Z blue. Units: mm.`;
}

function frame(box) {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const r = size.length() / 2;
  const dist = r / Math.sin((camera.fov * Math.PI) / 360);
  camera.position.copy(center).add(new THREE.Vector3(1, -1.2, 0.8).normalize().multiplyScalar(dist));
  camera.near = Math.max(dist / 1000, 0.1);
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

// ---- Parts mode ----
const LIB_COLOR = { rail: 'rail', plate: 'plate', tee_nut: 'fastener', wheel: 'wheel', motor: 'motor', pulley: 'pulley',
  screw: 'fastener', nut: 'fastener', spacer: 'fastener', bearing: 'fastener', shim: 'fastener', block: 'plate' };
const colorOfType = (t) => (TYPES.find(([n]) => n === (LIB_COLOR[t] || 'other')) || TYPES[TYPES.length - 1])[2];
let mode = 'asm', libIndex = null, partGroup = null, curPart = null;
const AX = [0xff4444, 0x44dd44, 0x4488ff];

function label(text, size) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d'); g.font = 'bold 36px sans-serif'; g.fillStyle = '#ffee88'; g.strokeStyle = '#000'; g.lineWidth = 6;
  g.strokeText(text, 4, 44); g.fillText(text, 4, 44);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  sp.scale.set(size * 4, size, 1); sp.center.set(0, 0); sp.renderOrder = 10;
  return sp;
}

/** Port frame: matrix columns x, y = z cross x, z. Triad length scales with the part. */
function portTriad(p, len) {
  const x = new THREE.Vector3(...p.x), z = new THREE.Vector3(...p.z), y = new THREE.Vector3().crossVectors(z, x);
  const g = new THREE.Group();
  g.matrix.makeBasis(x, y, z).setPosition(...p.origin); g.matrixAutoUpdate = false;
  const ax = new THREE.AxesHelper(len);
  ax.material.depthTest = false; ax.renderOrder = 9;
  g.add(ax);
  const l = label(p.name, len * 0.35); l.position.set(len * 0.1, len * 0.1, len * 0.1); l.userData.isLabel = true;
  g.add(l);
  return g;
}

function showPart(part, geometry, gltfScene) {
  select(null);
  if (model) { scene.remove(model); model = null; }
  if (partGroup) scene.remove(partGroup);
  parts = []; curPart = part;
  partGroup = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: colorOfType(part.type), roughness: 0.55, metalness: 0.2, side: THREE.DoubleSide });
  let obj;
  if (gltfScene) { obj = gltfScene; obj.traverse((o) => { if (o.isMesh) o.material = mat; }); }
  else obj = new THREE.Mesh(geometry, mat);
  partGroup.add(obj);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const unit = Math.max(4, Math.min(size.x, size.y, 80, Math.max(...part.dims) / 3));
  const origin = new THREE.AxesHelper(unit * 1.6); origin.material.depthTest = false; origin.renderOrder = 9;
  partGroup.add(origin);
  const portsG = new THREE.Group(); portsG.name = 'ports';
  for (const p of part.ports) portsG.add(portTriad(p, unit * 0.8));
  portsG.visible = $('t-ports').checked;
  portsG.traverse((o) => { if (o.userData.isLabel) o.visible = $('t-labels').checked; });
  partGroup.add(portsG);
  scene.add(partGroup);
  worldAxes.visible = false;
  makeGrid(box);
  grid.position.z = Math.min(box.min.z, 0);
  frame(box);
  const f = (v) => String(+v.toFixed(2));
  $('count').textContent = '';
  $('hint').textContent = 'Part frame at the origin: X red, Y green, Z blue. Port frames are small triads with labels (Z = out of the mating face). Units: mm.';
  $('info').innerHTML =
    `<b>${part.name}</b><br>type: ${part.type}${part.parametric ? ' (parametric)' : ''}<br>size X/Y/Z (mm): ${part.dims.map(f).join(' x ')}<br>` +
    (part.source ? `source: ${part.source.model} / ${part.source.node}<br>found in ${part.foundIn.length} model(s), ${part.instances} instance(s)<br>` : '') +
    `frame: ${part.transform.frame}<br><b>ports (${part.ports.length})</b><table>` +
    part.ports.map((p) => `<tr><td>${p.name}</td><td>(${p.origin.map(f).join(', ')})  z(${p.z.map(f).join(',')})${p.diameter ? ` d${f(p.diameter)}` : ''}</td></tr>`).join('') + '</table>';
  window.__viewer.part = part;
}

async function loadPart(slug) {
  document.querySelectorAll('#plist .it').forEach((e) => e.classList.toggle('on', e.dataset.slug === slug));
  $('param').hidden = true;
  const base = `library/${slug}/`;
  const [gltf, part] = await Promise.all([new GLTFLoader().loadAsync(base + 'part.glb'), fetch(base + 'part.json').then((r) => r.json())]);
  showPart(part, null, gltf.scene);
  if (part.parametric) { $('param').hidden = false; $('hint').textContent += ' Reference mesh at fixed length; use "param" generator below.'; }
}

function loadParametric(profile) {
  document.querySelectorAll('#plist .it').forEach((e) => e.classList.toggle('on', e.dataset.slug === 'vslot-' + profile));
  $('param').hidden = false;
  $('p-profile').value = profile;
  const len = Math.max(20, +$('p-len').value || 300);
  showPart(vslotPart(profile, len), vslotGeometry(profile, len), null);
}

async function initParts() {
  if (libIndex) return;
  libIndex = await fetch('library/index.json').then((r) => r.json()).catch(() => null);
  const box = $('plist');
  if (!libIndex) { box.textContent = 'No library/. Run: npm run library'; return; }
  const groups = {};
  for (const p of libIndex.parts) (groups[p.type] ||= []).push({ slug: p.slug, label: `${p.name}  [${p.dims.map((v) => +v.toFixed(1)).join('x')}]` });
  groups['rail (parametric)'] = Object.keys(PROFILES).map((k) => ({ slug: 'vslot-' + k, label: `V-Slot ${k} (generated)`, param: k }));
  box.innerHTML = Object.entries(groups).map(([t, items]) => `<div class="grp">${t}</div>` +
    items.map((i) => `<div class="it" data-slug="${i.slug}"${i.param ? ` data-param="${i.param}"` : ''}>${i.label}</div>`).join('')).join('');
  box.onclick = (e) => { const it = e.target.closest('.it'); if (!it) return; (it.dataset.param ? loadParametric(it.dataset.param) : loadPart(it.dataset.slug)).catch(console.error); };
  $('p-profile').innerHTML = Object.keys(PROFILES).map((k) => `<option>${k}</option>`).join('');
  $('p-profile').onchange = $('p-len').onchange = () => loadParametric($('p-profile').value);
}

function setMode(m, noDefault = false) {
  mode = m;
  $('m-asm').classList.toggle('on', m === 'asm'); $('m-parts').classList.toggle('on', m === 'parts');
  $('asm-box').hidden = m !== 'asm'; $('parts-box').hidden = m !== 'parts';
  if (m === 'asm') {
    if (partGroup) { scene.remove(partGroup); partGroup = null; }
    worldAxes.visible = $('t-world').checked;
    if (modelNames.length) load($('picker').value || modelNames[0]).catch(console.error);
  } else {
    if (model) { scene.remove(model); model = null; parts = []; }
    select(null);
    initParts().then(() => { if (libIndex && !partGroup && !noDefault) loadPart(libIndex.parts.find((p) => p.type === 'plate').slug).catch(console.error); });
  }
}
$('m-asm').onclick = () => mode !== 'asm' && setMode('asm');
$('m-parts').onclick = () => mode !== 'parts' && setMode('parts');
$('t-ports').onchange = (e) => partGroup?.getObjectByName('ports') && (partGroup.getObjectByName('ports').visible = e.target.checked);
$('t-labels').onchange = (e) => partGroup?.getObjectByName('ports')?.traverse((o) => { if (o.userData.isLabel) o.visible = e.target.checked; });

const key = (s) => s.replace(/[^A-Za-z0-9_]/g, ''); // GLTFLoader sanitises node names

async function load(name) {
  select(null);
  if (model) scene.remove(model);
  if (partGroup) { scene.remove(partGroup); partGroup = null; }
  const base = `models/${name}/`;
  const [gltf, cat] = await Promise.all([
    new GLTFLoader().loadAsync(base + 'assembly.glb'),
    fetch(base + 'catalog.json').then((r) => r.json()).catch(() => ({ solids: [] })),
  ]);
  catalog = new Map(cat.solids.map((s) => [key(`${s.name}__${s.instance}`), s]));
  model = gltf.scene;
  parts = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    const [, , color] = typeOf(o.name);
    o.material = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.2 });
    origMat.set(o, o.material);
    parts.push(o);
  });
  scene.add(model);
  const box = new THREE.Box3().setFromObject(model);
  makeGrid(box);
  frame(box);
  $('count').textContent = `${parts.length} parts`;
}

// ---- selection ----
function select(mesh) {
  if (selected) selected.material = origMat.get(selected);
  selected = mesh;
  partAxes.visible = false;
  if (!mesh) { $('info').textContent = 'Click a part.'; return; }
  mesh.material = highlight;
  const box = new THREE.Box3().setFromObject(mesh);
  const s = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const f = (v) => v.toFixed(2);
  const entry = catalog.get(key(mesh.name));
  const [type] = typeOf(mesh.name);
  partAxes.position.copy(mesh.getWorldPosition(new THREE.Vector3()));
  partAxes.quaternion.copy(mesh.getWorldQuaternion(new THREE.Quaternion()));
  partAxes.scale.setScalar(Math.max(0.2, Math.min(s.x, s.y, s.z, 100) / 50 + 0.5));
  partAxes.visible = $('t-part').checked;
  $('info').innerHTML =
    `<b>${mesh.name.replace(/_/g, ' ')}</b><br>type: ${type}<br>` +
    `size (mm): ${f(s.x)} x ${f(s.y)} x ${f(s.z)}<br>` +
    `bbox center: ${f(c.x)}, ${f(c.y)}, ${f(c.z)}<br>` +
    (entry ? `triangles: ${entry.triangles}<br>source index: ${entry.index}` : 'not in catalog');
}

let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; // it was a drag
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(parts, false)[0];
  select(hit ? hit.object : null);
});

// ---- UI ----
$('t-world').onchange = (e) => (worldAxes.visible = e.target.checked);
$('t-part').onchange = (e) => (partAxes.visible = e.target.checked && !!selected);
$('t-grid').onchange = (e) => grid && (grid.visible = e.target.checked);
$('picker').innerHTML = modelNames.map((n) => `<option>${n}</option>`).join('');
$('picker').onchange = (e) => load(e.target.value);

renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
// Deep link: #parts/<slug> or #parts/vslot-20x60
const hash = location.hash.match(/^#parts\/(.+)$/);
if (hash) {
  setMode('parts', true);
  initParts().then(() => (hash[1].startsWith('vslot-') ? loadParametric(hash[1].slice(6)) : loadPart(hash[1]))).catch(console.error);
} else if (modelNames.length) load(modelNames[0]).catch((e) => console.error(e));
else $('info').textContent = 'No models found in models/.';
window.__viewer = { load, setMode, loadPart, loadParametric, get parts() { return parts; }, select };
