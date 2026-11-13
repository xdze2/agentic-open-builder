import '@shoelace-style/shoelace/dist/themes/light.css';
import { setBasePath } from '@shoelace-style/shoelace/dist/utilities/base-path.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/icon-button/icon-button.js';
import '@shoelace-style/shoelace/dist/components/input/input.js';
import '@shoelace-style/shoelace/dist/components/select/select.js';
import '@shoelace-style/shoelace/dist/components/option/option.js';
import '@shoelace-style/shoelace/dist/components/tab-group/tab-group.js';
import '@shoelace-style/shoelace/dist/components/tab/tab.js';
import '@shoelace-style/shoelace/dist/components/tab-panel/tab-panel.js';
import '@shoelace-style/shoelace/dist/components/details/details.js';
import '@shoelace-style/shoelace/dist/components/dialog/dialog.js';
import '@shoelace-style/shoelace/dist/components/drawer/drawer.js';
import '@shoelace-style/shoelace/dist/components/range/range.js';
import '@shoelace-style/shoelace/dist/components/checkbox/checkbox.js';
import '@shoelace-style/shoelace/dist/components/tree/tree.js';
import '@shoelace-style/shoelace/dist/components/tree-item/tree-item.js';
import '@shoelace-style/shoelace/dist/components/dropdown/dropdown.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import modelNames from 'virtual:models';
import { PROFILES, railGeometry, vslotPart } from './vslot.js';
import { createBuild } from './buildmode.js';
import { createStage, VIEWS, GRID_MINOR, GRID_MAJOR } from './stage.js';

setBasePath('./shoelace'); // icons: <base>/shoelace/assets/icons (served / copied by vite.config.js)
const $ = (id) => document.getElementById(id);
const SNAP = new URLSearchParams(location.search).has('snap'); // minimal render mode (tools/snap.mjs)
if (SNAP) document.documentElement.classList.add('snap');

// Part type from name. First match wins, so order matters. Colours are tuned for a light background.
const TYPES = [
  ['rail', /v-?slot|rail(?!.*plate)|extrusion/i, 0x9aa5b5],
  ['plate', /plate|mount|bracket/i, 0x4f8fd6],
  ['wheel', /wheel/i, 0xe0883a],
  ['motor', /nema|motor/i, 0x3a4150],
  ['pulley', /pulley|gear|pinion/i, 0xd4a017],
  ['belt', /belt/i, 0x15171a],
  ['fastener', /screw|nut|spacer|shim|bearing|washer|bolt/i, 0x6fae4a],
  ['other', /./, 0xb050a0],
];
const typeOf = (name) => TYPES.find(([, re]) => re.test(name));

// ---- scene (orthographic stage: viewer/stage.js) ----
const stage = createStage({ $, canvasEl: $('canvas'), snap: SNAP });
const { renderer, scene, camera, controls, ndc, resize } = stage;
const worldAxes = new THREE.AxesHelper(100); // 100 mm
const partAxes = new THREE.AxesHelper(50);
partAxes.visible = false;
scene.add(worldAxes, partAxes);
let model = null, parts = [], selected = null, catalog = new Map(), partBox = null;

const origMat = new WeakMap();
const highlight = stage.surface(new THREE.MeshStandardMaterial({ color: 0xff3366, emissive: 0x661122, roughness: 0.4 }));
const frame = (box, dir = VIEWS.iso) => stage.fit(box, dir);
const fitScene = (box, groundZ) => stage.fitScene(box, groundZ);
const f1 = (v) => +(+v).toFixed(1);
/** "16 × 15.9 × 5 mm" */
const dimsText = (d) => d.map(f1).join(' × ') + ' mm';

// ---- Parts ----
const LIB_COLOR = { rail: 'rail', plate: 'plate', tee_nut: 'fastener', wheel: 'wheel', motor: 'motor', pulley: 'pulley',
  screw: 'fastener', nut: 'fastener', spacer: 'fastener', bearing: 'fastener', shim: 'fastener', block: 'plate' };
const colorOfType = (t) => (TYPES.find(([n]) => n === (LIB_COLOR[t] || 'other')) || TYPES[TYPES.length - 1])[2];
let mode = null, libIndex = null, partGroup = null, curPart = null, seq = 0; // mode: 'part' | 'build' | 'model'

function label(text, size) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d'); g.font = 'bold 36px sans-serif'; g.fillStyle = '#0b3d91'; g.strokeStyle = '#fff'; g.lineWidth = 6; g.lineJoin = 'round';
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
  if (partGroup) scene.remove(partGroup);
  parts = []; curPart = part;
  partGroup = new THREE.Group();
  const mat = stage.surface(new THREE.MeshStandardMaterial({ color: colorOfType(part.type), roughness: 0.55, metalness: 0.2, side: THREE.DoubleSide }));
  let obj;
  if (gltfScene) { obj = gltfScene; const ms = []; obj.traverse((o) => { if (o.isMesh) { o.material = mat; ms.push(o); } }); ms.forEach((o) => stage.decorate(o)); }
  else { obj = new THREE.Mesh(geometry, mat); stage.decorate(obj); }
  partGroup.add(obj);
  const box = partBox = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const unit = Math.max(4, Math.min(size.x, size.y, 80, Math.max(...part.dims) / 3));
  const origin = new THREE.AxesHelper(unit * 1.6); origin.material.depthTest = false; origin.renderOrder = 9;
  origin.name = 'origin'; origin.visible = $('t-world').checked;
  partGroup.add(origin);
  const portsG = new THREE.Group(); portsG.name = 'ports';
  for (const p of part.ports) portsG.add(portTriad(p, unit * 0.8));
  portsG.visible = $('t-ports').checked;
  portsG.traverse((o) => { if (o.userData.isLabel) o.visible = $('t-labels').checked; });
  partGroup.add(portsG);
  scene.add(partGroup);
  worldAxes.visible = false;
  fitScene(box, Math.min(box.min.z, 0));
  frame(box);
  const f = (v) => String(+v.toFixed(2));
  $('hint').textContent = `Grid: ${GRID_MINOR} mm minor / ${GRID_MAJOR} mm major, fixed. Part frame at the origin: X red, Y green, Z blue. Port frames are small triads with labels (Z = out of the mating face). Units: mm.`;
  $('info').innerHTML =
    `<b>${part.name}</b><br>type: ${part.type}${part.parametric ? ' (parametric)' : ''}<br>size: ${dimsText(part.dims)}<br>` +
    (part.source ? `source: ${part.source.model} / ${part.source.node}<br>found in ${part.foundIn.length} model(s), ${part.instances} instance(s)<br>` : '') +
    `frame: ${part.transform.frame}<br><b>ports (${part.ports.length})</b><table>` +
    part.ports.map((p) => `<tr><td>${p.name}</td><td>(${p.origin.map(f).join(', ')})  z(${p.z.map(f).join(',')})${p.diameter ? ` d${f(p.diameter)}` : ''}</td></tr>`).join('') + '</table>';
  window.__viewer.part = part;
}

async function loadPart(slug) {
  enter('part'); const my = ++seq;
  const base = `library/${slug}/`;
  const [gltf, part] = await Promise.all([new GLTFLoader().loadAsync(base + 'part.glb'), fetch(base + 'part.json').then((r) => r.json())]);
  if (my !== seq) return;
  showPart(part, null, gltf.scene);
  setCurrent('part', slug, part.name);
}

const RAIL_LENGTHS = [250, 500, 750, 1000, 1500]; // OpenBuilds standard cut lengths
let railLen = 500;
async function loadParametric(profile, len) {
  enter('part'); const my = ++seq;
  if (len) railLen = Math.max(20, Math.min(3000, +len || 500));
  $('partbar').hidden = false; $('pb-profile').textContent = `V-Slot ${profile}`;
  const geo = await railGeometry(profile, railLen);
  if (my !== seq) return;
  showPart(vslotPart(profile, railLen), geo, null);
  setCurrent('part', 'vslot-' + profile, `V-Slot ${profile} x ${railLen} mm (parametric)`);
  syncLengthBar();
}
function syncLengthBar() {
  document.querySelectorAll('#pb-lens sl-button').forEach((b) => (b.variant = +b.dataset.len === railLen ? 'primary' : 'default'));
  if ($('pb-custom') !== document.activeElement && !($('pb-custom').matches(':focus-within'))) $('pb-custom').value = String(railLen);
}

// ---- modes ----
let build = null;
function enter(m) {
  if (m !== 'build') build?.leave();
  if (m !== 'model' && model) { scene.remove(model); model = null; }
  if (m !== 'part' && partGroup) { scene.remove(partGroup); partGroup = null; }
  mode = m; parts = []; select(null);
  document.querySelectorAll('[data-mode]').forEach((e) => (e.hidden = e.dataset.mode !== m));
  $('bt-bom').hidden = m !== 'build';
  $('partbar').hidden = true;
  worldAxes.visible = m !== 'part' && $('t-world').checked;
  $('b-err').textContent = '';
  $('hint').textContent = `Grid: ${GRID_MINOR} mm minor / ${GRID_MAJOR} mm major, fixed extent (fades when zoomed out). Wheel zooms toward the cursor; the scale bar shows the current scale. Axes: X red, Y green, Z blue. Units: mm.`;
}
async function openBuild(file) {
  enter('build'); ++seq;
  build ||= createBuild({ $, scene, camera, renderer, controls, stage, fitScene, frame, colorOfType, ndc, afterTreePick: () => { if (mq.matches) $('dr-panel').hide(); }, onOpen: (f) => setCurrent('asm', f, f) });
  await build.enter(file);
}

const key = (s) => s.replace(/[^A-Za-z0-9_]/g, ''); // GLTFLoader sanitises node names

async function load(name) {
  enter('model'); const my = ++seq;
  if (model) { scene.remove(model); model = null; }
  const base = `models/${name}/`;
  const [gltf, cat] = await Promise.all([
    new GLTFLoader().loadAsync(base + 'assembly.glb'),
    fetch(base + 'catalog.json').then((r) => r.json()).catch(() => ({ solids: [] })),
  ]);
  if (my !== seq) return;
  catalog = new Map(cat.solids.map((s) => [key(`${s.name}__${s.instance}`), s]));
  model = gltf.scene;
  model.traverse((o) => {
    if (!o.isMesh) return;
    const [, , color] = typeOf(o.name);
    o.material = stage.surface(new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.2 }));
    stage.decorate(o, false);
    origMat.set(o, o.material);
    parts.push(o);
  });
  scene.add(model);
  const box = new THREE.Box3().setFromObject(model);
  fitScene(box);
  frame(box);
  $('info').textContent = `${parts.length} parts. Click a part.`;
  setCurrent('model', name, `STEP model: ${name}`);
}

// ---- selection (STEP models) ----
function select(mesh) {
  if (selected) selected.material = origMat.get(selected);
  selected = mesh;
  partAxes.visible = false;
  if (!mesh) { if (mode !== 'part') $('info').textContent = 'Click a part.'; return; }
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
    `size: ${f(s.x)} × ${f(s.y)} × ${f(s.z)} mm<br>` +
    `bbox center: ${f(c.x)}, ${f(c.y)}, ${f(c.z)} mm<br>` +
    (entry ? `triangles: ${entry.triangles}<br>source index: ${entry.index}` : 'not in catalog');
}

let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; // it was a drag
  if (mode === 'build') { build.show(build.hitAt(e.clientX, e.clientY)); return; }
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc(e.clientX, e.clientY), camera);
  const hit = ray.intersectObjects(parts, false)[0];
  select(hit ? hit.object : null);
});

// ---- browser (left): collapsible groups of cards with thumbnails ----
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const card = (kind, id, name, sub, thumb, type = '') => `<div class="card" data-kind="${kind}" data-id="${esc(id)}" data-q="${esc((name + ' ' + type).toLowerCase())}">` +
  `<div class="th"><img src="${thumb}" loading="lazy" alt=""></div><div class="nm">${esc(name)}</div><div class="sz">${esc(sub)}</div></div>`;
document.addEventListener('error', (e) => { // missing thumbnail -> placeholder
  const t = e.target; if (t.tagName === 'IMG' && t.closest('.card')) t.parentElement.innerHTML = '<sl-icon name="box"></sl-icon>';
}, true);

// open/closed state of the groups, remembered in localStorage (all open by default)
const GKEY = 'ob_groups_v1';
const gState = (() => { try { return JSON.parse(localStorage.getItem(GKEY)) || {}; } catch (e) { return {}; } })();
const saveG = () => { try { localStorage.setItem(GKEY, JSON.stringify(gState)); } catch (e) { /* private mode */ } };
const group = (tab, title, cards) => `<div class="gbox" data-gk="${esc(tab + ':' + title)}"><div class="grp" data-grp tabindex="0" role="button"><span class="chev">▾</span> ${esc(title)} <span class="gn">${cards.length}</span></div><div class="cards" data-grp-cards>${cards.join('')}</div></div>`;
/** apply the search query and the stored open state; a query expands every group that has a match */
function applyGroups(listId, q = '') {
  for (const c of $(listId).querySelectorAll('.card')) c.hidden = !!q && !c.dataset.q.includes(q);
  for (const g of $(listId).querySelectorAll('.gbox')) {
    const hits = g.querySelector('.card:not([hidden])') !== null, open = q ? hits : gState[g.dataset.gk] !== false;
    g.hidden = !hits; g.querySelector('[data-grp-cards]').hidden = !open; g.querySelector('.chev').textContent = open ? '▾' : '▸';
  }
}
function bindList(listId, searchId, onPick) {
  const toggle = (g) => { gState[g.dataset.gk] = gState[g.dataset.gk] === false; saveG(); applyGroups(listId, $(searchId).value.trim().toLowerCase()); };
  $(listId).addEventListener('click', (e) => {
    const h = e.target.closest('[data-grp]'); if (h) return toggle(h.parentElement);
    const c = e.target.closest('.card'); if (c) onPick(c.dataset.kind, c.dataset.id);
  });
  $(listId).addEventListener('keydown', (e) => { const h = e.target.closest?.('[data-grp]'); if (h && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(h.parentElement); } });
  $(searchId).addEventListener('sl-input', (e) => applyGroups(listId, e.target.value.trim().toLowerCase()));
}

// fixed-length STEP rail meshes stay in the library (assemblies use them) but get no card: the profile cards cover rails
const isStepRail = (p) => p.type === 'rail' && /^v-slot-/.test(p.slug);
async function initLists() {
  libIndex = await fetch('library/index.json').then((r) => r.json()).catch(() => null);
  if (!libIndex) $('plist').textContent = 'No library/. Run: npm run library';
  else {
    const groups = {};
    groups.rail = Object.keys(PROFILES).map((k) => card('part', 'vslot-' + k, `V-Slot ${k}`, `${PROFILES[k].map((n) => n * 20).join(' × ')} mm profile, any length`, `library/_thumbs/vslot-${k}.png`, 'rail parametric profile v-slot extrusion'));
    for (const p of libIndex.parts) if (!isStepRail(p)) (groups[p.type] ||= []).push(card('part', p.slug, p.name, dimsText(p.dims), `library/${p.slug}/thumb.png`, p.type));
    $('plist').innerHTML = Object.entries(groups).map(([t, c]) => group('parts', t, c)).join('');
  }
  $('mlist').innerHTML = modelNames.length ? group('models', 'converted STEP models', modelNames.map((n) => card('model', n, n.replace(/_/g, ' '), 'STEP', `models/${n}/thumb.png`))) : 'No models found in models/.';
  applyGroups('plist'); applyGroups('mlist');
  await listAssemblies();
}
async function listAssemblies() {
  const files = await fetch('assemblies/_list.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => []);
  $('alist').innerHTML = files.length ? group('asm', 'assembly files', files.map((f) => card('asm', f, f.replace(/\.json$/, ''), 'assembly JSON', `assemblies/_thumbs/${f.replace(/\.json$/, '')}.png`))) : 'No assemblies/*.json';
  applyGroups('alist', $('q-asm').value.trim().toLowerCase());
  markActive();
  return files;
}
let current = null;
function markActive() { document.querySelectorAll('.card').forEach((c) => c.classList.toggle('on', !!current && c.dataset.kind === current.kind && c.dataset.id === current.id)); }
function setCurrent(kind, id, title) {
  current = { kind, id }; markActive();
  $('title').textContent = title;
  const h = { part: 'parts/', asm: 'assemblies/', model: 'models/' }[kind] + id;
  history.replaceState(null, '', location.search + '#' + h);
  document.title = `${title} - OpenBuilds viewer`;
}

async function openItem(kind, id, o = {}) {
  if (kind === 'part') return id.startsWith('vslot-') ? loadParametric(id.slice(6), o.len) : loadPart(id);
  if (kind === 'asm') { await openBuild(id); if (o.state) await build.setState(o.state); return; }
  return load(id);
}
const pick = (kind, id) => { openItem(kind, id).catch(console.error); if (mq.matches) $('dr-browser').hide(); };
bindList('plist', 'q-parts', pick); bindList('alist', 'q-asm', pick); bindList('mlist', 'q-models', pick);
const curProfile = () => (current && current.kind === 'part' && current.id.startsWith('vslot-') ? current.id.slice(6) : null);
document.querySelectorAll('#pb-lens sl-button').forEach((b) => b.addEventListener('click', () => curProfile() && loadParametric(curProfile(), +b.dataset.len)));
const setCustomLen = () => { const v = +$('pb-custom').value; if (curProfile() && v >= 20) loadParametric(curProfile(), v); };
$('pb-custom').addEventListener('sl-change', setCustomLen);

// ---- layout: side columns, or drawers when narrow ----
const mq = matchMedia('(max-width: 900px)');
function layout() {
  $('app').classList.toggle('narrow', mq.matches);
  (mq.matches ? $('dr-browser') : $('browser')).appendChild($('browser-body'));
  (mq.matches ? $('dr-panel') : $('panel')).appendChild($('panel-body'));
}
mq.addEventListener('change', layout); layout();
$('bt-browser').onclick = () => (mq.matches ? $('dr-browser').show() : $('app').classList.toggle('nobrowser'));
$('bt-panel').onclick = () => (mq.matches ? $('dr-panel').show() : $('app').classList.toggle('nopanel'));
$('bt-bom').onclick = () => $('bom-dlg').show();
$('bom-close').onclick = () => $('bom-dlg').hide();
$('bom-copy').onclick = async () => {
  const text = build?.bomText() || '';
  try { await navigator.clipboard.writeText(text); } catch (e) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e2) { /* ignore */ } ta.remove(); }
  $('bom-copy').textContent = 'Copied'; setTimeout(() => { $('bom-copy').innerHTML = '<sl-icon slot="prefix" name="clipboard"></sl-icon>Copy as text'; }, 1500);
};

const curBox = () => (mode === 'build' ? new THREE.Box3().setFromObject(build.group) : mode === 'model' && model ? new THREE.Box3().setFromObject(model) : partBox);
// ---- display toggles ----
const on = (id, fn) => $(id).addEventListener('sl-change', (e) => fn(e.target.checked));
on('t-ports', (v) => partGroup?.getObjectByName('ports') && (partGroup.getObjectByName('ports').visible = v));
on('t-labels', (v) => partGroup?.getObjectByName('ports')?.traverse((o) => { if (o.userData.isLabel) o.visible = v; }));
on('t-world', (v) => { worldAxes.visible = mode !== 'part' && v; const o = partGroup?.getObjectByName('origin'); if (o) o.visible = v; });
on('t-part', (v) => (partAxes.visible = v && !!selected));
on('t-grid', (v) => stage.setGrid(v));
on('t-shadows', (v) => stage.setShadows(v));
on('t-edges', (v) => stage.setEdges(v));
// the toggles are remembered (not in snap mode, which sets them itself)
const VKEY = 'ob_view_v1', VIEW_IDS = ['t-world', 't-part', 't-grid', 't-shadows', 't-edges', 'b-ports', 't-ports', 't-labels'];
const viewState = (() => { try { return JSON.parse(localStorage.getItem(VKEY)) || {}; } catch (e) { return {}; } })();
if (!SNAP) for (const id of VIEW_IDS) {
  const el = $(id);
  if (typeof viewState[id] === 'boolean') { el.checked = viewState[id]; el.dispatchEvent(new CustomEvent('sl-change')); }
  el.addEventListener('sl-change', () => { viewState[id] = el.checked; try { localStorage.setItem(VKEY, JSON.stringify(viewState)); } catch (e) { /* private mode */ } });
}

// zoom / fit / view presets: toolbar overlay in the 3D view
document.addEventListener('click', (e) => {
  const z = e.target.closest?.('[data-zoom]'), v = e.target.closest?.('[data-view]');
  if (z) { const a = z.dataset.zoom; if (a === 'in') stage.zoomBy(1.4); else if (a === 'out') stage.zoomBy(1 / 1.4); else if (a === 'fit') { const b = curBox(); if (b) stage.fit(b); } }
  if (v) { const b = curBox(); if (b) stage.fit(b, VIEWS[v.dataset.view]); }
});

// ---- render loop ----
renderer.setAnimationLoop(() => { stage.tick(); renderer.render(scene, camera); });

// ---- routing: #parts/<slug> | #assemblies/<file.json> (or legacy #build/<file>) | #models/<name> ----
function parseHash(h = location.hash) {
  const m = h.match(/^#(parts|assemblies|build|models)\/(.+)$/);
  return m ? { kind: { parts: 'part', assemblies: 'asm', build: 'asm', models: 'model' }[m[1]], id: decodeURIComponent(m[2]) } : null;
}
addEventListener('hashchange', () => { const t = parseHash(); if (t && !(current && current.kind === t.kind && current.id === t.id)) openItem(t.kind, t.id).catch(console.error); });
if (import.meta.hot) import.meta.hot.on('assemblies-changed', () => listAssemblies());

// ---- snapshot API (tools/snap.mjs): one page, many items ----
let snapKey = null;

/** target {kind:'part'|'asm'|'model', id, state?}, view = iso|top|front|right|back|left|bottom, o = {axes, grid} */
async function snapLoad(t, view = 'iso', o = {}) {
  window.__snapReady = false;
  const axes = o.axes ?? true, grd = o.grid ?? true, k = JSON.stringify([t, axes, grd]);
  $('t-world').checked = axes; $('t-grid').checked = grd; stage.setGrid(grd); $('t-ports').checked = false; $('t-labels').checked = false; $('t-part').checked = false;
  if (k !== snapKey) { snapKey = null; await openItem(t.kind, t.id, { state: t.state, len: t.len }); snapKey = k; }
  resize();
  frame(curBox(), VIEWS[view] || VIEWS.iso);
  renderer.render(scene, camera);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__snapError = $('b-err').textContent;
  window.__snapReady = true;
  return window.__snapError;
}

window.__viewer = { setClip: (z) => { renderer.localClippingEnabled = false; renderer.clippingPlanes = z === null ? [] : [new THREE.Plane(new THREE.Vector3(0, 0, -1), -z)]; }, get build() { return build; }, get prompt() { return build?.prompt; }, stage, camera, controls, load, loadPart, loadParametric, openItem, get parts() { return parts; }, select };
window.__snapLoad = snapLoad;

// ---- start ----
(async () => {
  await initLists();
  const t = parseHash();
  if (SNAP) {
    const p = new URLSearchParams(location.search);
    window.__snapIdle = true;
    if (t) await snapLoad({ ...t, len: p.get('len') ? +p.get('len') : undefined, state: p.get('state') ? Object.fromEntries(p.get('state').split(',').map((kv) => { const [a, b] = kv.split('='); return [a, +b]; })) : undefined }, p.get('view') || 'iso', { axes: p.get('axes') !== '0', grid: p.get('grid') !== '0' });
    return;
  }
  if (t) return openItem(t.kind, t.id);
  const files = [...$('alist').querySelectorAll('.card')].map((c) => c.dataset.id);
  if (files.length) return openItem('asm', files.includes('plotter.json') ? 'plotter.json' : files[0]);
  if (libIndex) return openItem('part', libIndex.parts[0].slug);
})().catch(console.error);
