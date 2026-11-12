import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import modelNames from 'virtual:models';

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

const key = (s) => s.replace(/[^A-Za-z0-9_]/g, ''); // GLTFLoader sanitises node names

async function load(name) {
  select(null);
  if (model) scene.remove(model);
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
if (modelNames.length) load(modelNames[0]).catch((e) => console.error(e));
else $('info').textContent = 'No models found in models/.';
window.__viewer = { load, get parts() { return parts; }, select };
