// 3D stage: orthographic camera, lights + shadows, fixed-spacing grid, zoom / fit / view presets, scale bar.
// Units: mm. The ortho frustum is in screen pixels, so camera.zoom = pixels per mm exactly.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export const GRID_MINOR = 10, GRID_MAJOR = 100, GRID_HALF = 1500; // mm: fixed spacing, fixed extent (never follows the item)
export const VIEWS = { iso: [1, -1.2, 0.8], top: [0, -0.001, 1], bottom: [0, -0.001, -1], front: [0, -1, 0], back: [0, 1, 0], right: [1, 0, 0], left: [-1, 0, 0] };
const DIST = 5000, MIN_ZOOM = 0.04, MAX_ZOOM = 60; // camera distance (constant: ortho), zoom limits in px/mm
const NICE = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

export function createStage({ $, canvasEl, snap }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(snap ? 1 : devicePixelRatio);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false; // re-rendered only when the scene changes (fitScene / refreshShadows)
  canvasEl.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf3f5f8);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, DIST * 2);
  camera.up.set(0, 0, 1); // Z-up; must be set before OrbitControls is created
  camera.position.set(1, -1.2, 0.8).normalize().multiplyScalar(DIST);
  // wheel zoom is ours (smooth, toward the cursor): swallow wheel events before OrbitControls sees them (touch pinch stays with OrbitControls)
  const wheel = { target: 1, nx: 0, ny: 0, active: false };
  renderer.domElement.addEventListener('wheel', (e) => {
    e.preventDefault(); e.stopImmediatePropagation();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
    const r = renderer.domElement.getBoundingClientRect();
    wheel.nx = ((e.clientX - r.left) / r.width) * 2 - 1; wheel.ny = -(((e.clientY - r.top) / r.height) * 2 - 1);
    wheel.target = clampZoom((wheel.active ? wheel.target : camera.zoom) * Math.exp(-Math.max(-300, Math.min(300, px)) * 0.0016));
    wheel.active = true;
  }, { passive: false });
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enableZoom = true; // touch pinch only
  controls.minZoom = MIN_ZOOM; controls.maxZoom = MAX_ZOOM;
  const clampZoom = (z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

  // ---- lights: world-fixed key (shadows), hemisphere, fill ----
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8d95a3, 0.85);
  hemi.position.set(0, 0, 1); // sky = +Z
  const key = new THREE.DirectionalLight(0xffffff, 2.7);
  const KEY_DIR = new THREE.Vector3(-0.55, -0.9, 1.5).normalize();
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 3; key.shadow.blurSamples = 12;
  key.shadow.bias = -0.0004;
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.55);
  fill.position.set(1, 0.6, 0.3);
  scene.add(hemi, key, key.target, fill);

  // ground shadow on the grid plane
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GRID_HALF * 2, GRID_HALF * 2), new THREE.ShadowMaterial({ opacity: 0.28, depthWrite: false }));
  ground.receiveShadow = true; ground.renderOrder = -2;
  scene.add(ground);

  // fixed grid: 10 mm minor / 100 mm major, +-1500 mm around the world origin; lines fade out when too dense on screen
  function gridLines(step, skipMajor) {
    const pts = [];
    for (let v = -GRID_HALF; v <= GRID_HALF; v += step) {
      if (skipMajor && v % GRID_MAJOR === 0) continue;
      pts.push(v, -GRID_HALF, 0, v, GRID_HALF, 0, -GRID_HALF, v, 0, GRID_HALF, v, 0);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: skipMajor ? 0xdde1e8 : 0x9aa3b2, transparent: true, depthWrite: false }));
  }
  const grid = new THREE.Group();
  const minor = gridLines(GRID_MINOR, true), major = gridLines(GRID_MAJOR, false);
  minor.renderOrder = -1; major.renderOrder = -1;
  grid.add(minor, major); scene.add(grid);
  let gridOn = true, shadowsOn = true;
  const gridFade = () => { // minor lines below ~4 px spacing fade out, major below ~3 px
    const z = camera.zoom;
    minor.material.opacity = Math.max(0, Math.min(1, (GRID_MINOR * z - 3) / 5));
    major.material.opacity = Math.max(0, Math.min(1, (GRID_MAJOR * z - 2) / 4)) * 0.9;
    minor.visible = minor.material.opacity > 0.01;
  };

  // ---- decorations: shadows + optional edge overlay (EdgesGeometry, 30 deg) ----
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x1b2330, transparent: true, opacity: 0.4 });
  const edgeCache = new WeakMap();
  function decorate(mesh, edges = true) {
    mesh.castShadow = true; mesh.receiveShadow = true;
    if (!edges || mesh.userData.hasEdges) return;
    let eg = edgeCache.get(mesh.geometry);
    if (!eg) { eg = new THREE.EdgesGeometry(mesh.geometry, 30); edgeCache.set(mesh.geometry, eg); }
    const l = new THREE.LineSegments(eg, edgeMat);
    l.raycast = () => {}; l.userData.isEdges = true;
    mesh.add(l); mesh.userData.hasEdges = true;
  }
  /** polygonOffset keeps the edge lines in front of the faces they trace */
  const surface = (m) => { m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1; return m; };

  const refreshShadows = () => { renderer.shadowMap.needsUpdate = true; };
  /** ground plane / grid at the item's lowest Z, key light + shadow camera fitted to its bounding sphere */
  function fitScene(box, groundZ = box.min.z) {
    const sph = box.getBoundingSphere(new THREE.Sphere()), r = Math.max(sph.radius, 20);
    grid.position.z = groundZ; ground.position.z = groundZ;
    key.target.position.copy(sph.center); key.target.updateMatrixWorld();
    key.position.copy(sph.center).addScaledVector(KEY_DIR, r * 3);
    const c = key.shadow.camera;
    c.left = -r * 1.05; c.right = r * 1.05; c.top = r * 1.05; c.bottom = -r * 1.05; c.near = r * 0.5; c.far = r * 5.5;
    c.updateProjectionMatrix();
    key.shadow.normalBias = r * 0.0006; // mm
    refreshShadows();
  }
  function setShadows(v) { shadowsOn = v; key.castShadow = v; ground.visible = v; refreshShadows(); }
  const setGrid = (v) => { gridOn = v; grid.visible = v; };
  const setEdges = (v) => { edgeMat.visible = v; };

  // ---- size ----
  function resize() {
    const w = Math.max(1, canvasEl.clientWidth), h = Math.max(1, canvasEl.clientHeight);
    renderer.setSize(w, h);
    camera.left = -w / 2; camera.right = w / 2; camera.top = h / 2; camera.bottom = -h / 2;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvasEl);
  resize();
  const ndc = (cx, cy) => { const r = renderer.domElement.getBoundingClientRect(); return new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1); };

  // ---- zoom / fit ----
  const basis = () => ({ x: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), y: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1) });
  /** zoom (px/mm) that fits the box in the current view direction; minSize (mm) caps the zoom for tiny targets */
  function fitZoom(box, minSize = 0, margin = 1.08) {
    camera.updateMatrixWorld();
    const { x, y } = basis(), c = box.getCenter(new THREE.Vector3());
    let hx = 0, hy = 0;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(c);
      hx = Math.max(hx, Math.abs(p.dot(x))); hy = Math.max(hy, Math.abs(p.dot(y)));
    }
    hx = Math.max(hx, minSize / 2); hy = Math.max(hy, minSize / 2);
    return clampZoom(Math.min(camera.right / hx, camera.top / hy) / margin);
  }
  /** frame a box from a view direction (default: keep the current direction) */
  function fit(box, dir) {
    resize(); // layout may have changed since the last observer callback (bars shown / hidden)
    const center = box.getCenter(new THREE.Vector3());
    const d = dir ? new THREE.Vector3(...dir).normalize() : camera.position.clone().sub(controls.target).normalize();
    wheel.active = false; flyId++;
    camera.position.copy(center).addScaledVector(d, DIST);
    controls.target.copy(center);
    camera.lookAt(center); camera.updateMatrixWorld();
    camera.zoom = fitZoom(box); camera.updateProjectionMatrix();
    if (!snap) controls.update();
    refreshView();
  }
  let flyId = 0;
  /** animated move to a box (same view direction), zoom fitted with a minimum visible size */
  function flyTo(box, minSize = 40) {
    resize();
    const c1 = box.getCenter(new THREE.Vector3()), z1 = fitZoom(box, minSize, 1.3);
    const d = camera.position.clone().sub(controls.target).normalize();
    const t0 = controls.target.clone(), z0 = camera.zoom, id = ++flyId, T = performance.now();
    wheel.active = false;
    (function step(now) {
      if (id !== flyId) return;
      const k = Math.min(1, (now - T) / 450), e = k * k * (3 - 2 * k);
      controls.target.lerpVectors(t0, c1, e);
      camera.position.copy(controls.target).addScaledVector(d, DIST);
      camera.zoom = Math.exp(Math.log(z0) * (1 - e) + Math.log(z1) * e); camera.updateProjectionMatrix();
      controls.update(); if (k < 1) requestAnimationFrame(step);
    })(T);
  }
  addEventListener('pointerdown', () => { flyId++; }, true); // the user grabbed the camera
  /** button zoom: x factor, toward the view centre, smooth */
  function zoomBy(f) { wheel.nx = 0; wheel.ny = 0; wheel.target = clampZoom((wheel.active ? wheel.target : camera.zoom) * f); wheel.active = true; }
  function applyWheel() {
    if (!wheel.active) return;
    const z0 = camera.zoom; let z1 = z0 + (wheel.target - z0) * 0.3;
    if (Math.abs(wheel.target - z0) / z0 < 0.002) { z1 = wheel.target; wheel.active = false; }
    camera.updateMatrixWorld();
    const { x, y } = basis(), k = 1 / z0 - 1 / z1; // keep the point under the cursor fixed
    const shift = x.multiplyScalar(wheel.nx * camera.right * k).addScaledVector(y, wheel.ny * camera.top * k);
    camera.position.add(shift); controls.target.add(shift);
    camera.zoom = z1; camera.updateProjectionMatrix();
  }

  // ---- scale bar ----
  const sb = $('scalebar');
  let sbZoom = 0;
  function refreshView() {
    if (camera.zoom === sbZoom) return;
    sbZoom = camera.zoom;
    const mm = [...NICE].reverse().find((n) => n * camera.zoom <= 140) || NICE[0];
    if (sb) { $('sb-line').style.width = Math.round(mm * camera.zoom) + 'px'; $('sb-text').textContent = (mm >= 1000 ? mm / 1000 + ' m' : mm + ' mm'); }
    gridFade();
  }

  function tick() {
    if (!snap) { applyWheel(); controls.update(); }
    refreshView();
  }
  return { renderer, scene, camera, controls, ndc, resize, decorate, surface, fitScene, refreshShadows, fit, flyTo, zoomBy, fitZoom, tick, setShadows, setGrid, setEdges, VIEWS, get gridOn() { return gridOn; }, get shadowsOn() { return shadowsOn; } };
}
