// "Build" tab: loads assemblies/*.json, solves them with lib/assembly.js, renders the instances, sliders for joints,
// BOM, hover/click naming (instance, port, hole) and live reload (Vite HMR event 'assemblies-changed').
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { solve, AsmError, findPort } from '../lib/assembly.js';
import * as m4 from '../lib/mat.js';
import { railGeometry } from './vslot.js';
import { slotsOf, FACES } from '../lib/vslot_ports.js';
import { edgePorts } from '../lib/assembly.js';
import { createPrompt, short, portWords } from './prompt.js';

export function createBuild(ctx) {
  const { $, scene, camera, renderer, controls, stage, fitScene, frame, colorOfType, ndc } = ctx;
  const group = new THREE.Group();
  const marker = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff6a00, depthTest: false }));
  marker.renderOrder = 20; marker.visible = false;
  const edgeLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]), new THREE.LineBasicMaterial({ color: 0xff6a00, depthTest: false }));
  edgeLine.renderOrder = 21; edgeLine.visible = false; edgeLine.frustumCulled = false;
  // click tolerances: 4 mm (plate edge) / 5 mm (port, hole) at normal zoom; widened to ~6 / 8 screen pixels when zoomed out (px = camera.zoom * mm), capped at 10 / 12 mm
const edgeTol = () => Math.max(4, Math.min(10, 6 / camera.zoom)), portTol = () => Math.max(5, Math.min(12, 8 / camera.zoom));
  const geoCache = new Map(), defCache = new Map();
  let bomLines = [], file = null, asm = null, res = null, meshes = new Map(), overrides = {}, selected = null, framed = null;
  const highlight = stage.surface(new THREE.MeshStandardMaterial({ color: 0xff3366, emissive: 0x661122, roughness: 0.4 }));
  const matByType = new Map();
  const matFor = (type) => { if (!matByType.has(type)) matByType.set(type, stage.surface(new THREE.MeshStandardMaterial({ color: colorOfType(type), roughness: 0.55, metalness: 0.2 }))); return matByType.get(type); };

  const loader = {
    index: () => fetch('library/index.json').then((r) => r.json()),
    part: async (slug) => { if (!defCache.has(slug)) defCache.set(slug, await fetch(`library/${slug}/part.json`).then((r) => r.json())); return defCache.get(slug); },
    assembly: (f) => fetch(`assemblies/${f}`, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new AsmError(`cannot load assemblies/${f}`); return r.json(); }),
  };
  async function geometryOf(inst) {
    if (inst.def.parametric && inst.def.length) return railGeometry(inst.def.profile, inst.def.length);
    if (!geoCache.has(inst.slug)) {
      const g = await new GLTFLoader().loadAsync(`library/${inst.slug}/part.glb`);
      let geo = null; g.scene.traverse((o) => { if (o.isMesh && !geo) geo = o.geometry; });
      geoCache.set(inst.slug, geo);
    }
    return geoCache.get(inst.slug);
  }
  const toMatrix = (M) => new THREE.Matrix4().set(...M);

  async function rebuild(keepCamera) {
    $('b-err').textContent = '';
    try { res = await solve(asm, loader, { state: overrides, file }); }
    catch (e) {
      $('b-err').textContent = 'ERROR: ' + e.message; if (!(e instanceof AsmError)) console.error(e); return;
    }
    const names = res.instances.map((i) => i.name).join('|');
    if (rebuild.names !== names || !meshes.size) {
      for (const m of [...group.children]) group.remove(m);
      meshes = new Map();
      for (const inst of res.instances) {
        const mesh = new THREE.Mesh(await geometryOf(inst), matFor(inst.def.type));
        mesh.matrixAutoUpdate = false; mesh.userData = { name: inst.name }; stage.decorate(mesh);
        group.add(mesh); meshes.set(inst.name, mesh);
      }
      rebuild.names = names; selected = null;
    }
    for (const inst of res.instances) { const m = meshes.get(inst.name); m.matrix.copy(toMatrix(inst.M)); m.matrixWorldNeedsUpdate = true; }
    group.updateMatrixWorld(true);
    renderPanel(); hover(null); prompt.refresh();
    const box = new THREE.Box3().setFromObject(group); fitScene(box);
    if (!keepCamera || framed !== file) { frame(box); framed = file; }
  }

  function renderPanel() {
    // sliders (only rebuilt when the set of joints changes, so dragging is not interrupted)
    const sig = res.joints.map((j) => j.state).join(',');
    if (renderPanel.sig !== sig) {
      renderPanel.sig = sig;
      $('b-sliders').innerHTML = res.joints.map((j) => `<div class="j"><div>${j.state}: <b id="jv-${j.state}">${j.value}</b> mm <span style="color:var(--sl-color-neutral-500)">${j.label || ''}</span></div>` +
        `<sl-range data-j="${j.state}" min="${j.range ? j.range[0] : 0}" max="${j.range ? j.range[1] : 500}" step="0.5" value="${j.value}"></sl-range></div>`).join('') || '<i>none</i>';
      $('b-sliders').querySelectorAll('sl-range').forEach((el) => el.addEventListener('sl-input', () => { overrides[el.dataset.j] = +el.value; $('jv-' + el.dataset.j).textContent = el.value; scheduleUpdate(); }));
    } else for (const j of res.joints) { const el = $('jv-' + j.state); if (el) el.textContent = j.value; }
    $('b-bom').innerHTML = '<table>' + res.bom.map((r) => `<tr><td>${r.count} x</td><td>${r.type}</td><td>${r.cut_length ? `${r.profile || ''} V-slot rail, cut <b>${r.cut_length} mm</b>${r.parametric ? '' : ' (library mesh)'}, ${dimsText(r.dims)}` : `${r.slug} <span style="color:var(--sl-color-neutral-500)">${dimsText(r.dims)}</span>`}</td></tr>`).join('') + '</table>' +
      `<div style="color:var(--sl-color-neutral-500)">${res.instances.length} instances</div>`;
    $('b-mounts').innerHTML = res.mounts.map((m) => `<b>${m.name}</b>: ${m.rail} on ${m.plate} ${m.plate_face}, ${m.direction}, overhang ${m.overhang} mm` +
      (m.screw ? `<br>screw ${m.screw.slug.replace('low-profile-screw-m5-9x9x', 'M5 LP ')} (L${m.screw.length}, +${m.screw.protrusion} mm through)<br>` + m.fasteners.map((h) => `${h.hole} @ ${h.at_mm_from_end_a} mm`).join('<br>') : '')).join('<hr>') || '<i>none</i>';
    bomLines = res.bom.map((r) => `${r.count} x ${r.type}  ${bomText(r)}`);
    if (res.warnings.length) $('b-err').textContent = res.warnings.map((w) => 'WARNING: ' + w).join('\n');
  }
  let pending = false;
  function scheduleUpdate() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; rebuild(true).catch(console.error); }); }

  // ---- naming: instance, port / hole nearest to a hit ----
  const f2 = (v) => +v.toFixed(2);
  const dimsText = (d) => d.map((v) => +(+v).toFixed(1)).join(' × ') + ' mm';
  const bomText = (r) => `${r.cut_length ? `${r.profile || ''} V-slot rail, cut ${r.cut_length} mm${r.parametric ? '' : ' (library mesh)'}` : r.slug}${r.cut_length ? '' : `  (${dimsText(r.dims)})`}`;
  function describeHit(hit) {
    const name = hit.object.userData.name, inst = res.instances.find((i) => i.name === name);
    const def = inst.def, p = m4.point(m4.inv(inst.M), hit.point.toArray());
    const out = { name, def, p, refs: [] };
    const nm = name;
    let best = null;
    const consider = (label, o, extra) => { const d = Math.hypot(o[0] - p[0], o[1] - p[1], o[2] - p[2]); if (!best || d < best.d) best = { d, label, o, extra }; };
    for (const q of def.ports) consider(q.name, q.origin);
    if (def.holes) {
      const t = def.dims[2], face = Math.abs(p[2]) < Math.abs(p[2] - t) ? 'front' : 'back';
      for (const h of def.holes) consider(`${face}:${h.name}${h.alias ? ` (${h.alias})` : ''}`, [h.x, h.y, face === 'front' ? 0 : t], { hole: h, face });
    }
    if (def.profile) { // rail: face + slot + position along the rail
      const [W, H] = [def.dims[0], def.dims[1]];
      const fs = Object.entries(FACES).map(([f, { n }]) => [f, Math.abs(p[0] * n[0] + p[1] * n[1] - (n[0] ? W : H) / 2)]).sort((a, b) => a[1] - b[1])[0];
      if (fs[1] < 1.5) {
        const face = fs[0], u = face === 'top' || face === 'bottom' ? p[0] : p[1];
        const slot = slotsOf(def.profile, face).map((s) => ({ ...s, dd: Math.abs(s.u - u) })).sort((a, b) => a.dd - b.dd)[0];
        out.rail = { face, slot: slot.index, at: f2(p[2]), onSlot: slot.dd < 4 };
        out.refs.push(`${nm}.${face}_slot_${slot.index}@${f2(p[2])}`);
      }
    }
    if (def.type === 'plate' && def.bbox) { // plate edges: bounding-rectangle sides, plate-local
      const { min, max } = def.bbox;
      let eb = null; const et = edgeTol();
      for (const e of edgePorts(def)) {
        const ax = e.z[0] ? 0 : 1, oax = 1 - ax, d = Math.abs(p[ax] - e.origin[ax]);
        if (p[oax] < min[oax] - et || p[oax] > max[oax] + et || p[2] < min[2] - et || p[2] > max[2] + et) continue;
        if (d <= et && (!eb || d < eb.d)) eb = { d, e };
      }
      if (eb) { out.edge = eb; out.refs.unshift(`${nm}.${eb.e.name}`); }
    }
    if (best && best.d < 12 && !out.edge) { out.port = best; out.refs.unshift(`${nm}.${best.extra?.hole ? `${best.extra.face}:${best.extra.hole.name}` : best.label}`); }
    // the chip: edge (<4 mm) > port / hole (<5 mm) > the whole instance
    if (out.edge) out.sel = { ref: `${nm}.${out.edge.e.name}`, label: `${short(nm)} › ${portWords(out.edge.e.name)}` };
    else if (best && best.d < portTol()) out.sel = { ref: out.refs[0], label: `${short(nm)} › ${best.extra?.hole ? 'hole ' + best.extra.hole.name : best.label}` };
    else out.sel = { ref: nm, label: short(nm) };
    if (def.holes) out.refs.push(`${nm}.${Math.abs(p[2]) < Math.abs(p[2] - def.dims[2]) ? 'front' : 'back'}@${f2(p[0])},${f2(p[1])}`);
    return out;
  }
  function show(hit, silent) {
    if (selected) selected.material = matFor(res.instances.find((i) => i.name === selected.userData.name).def.type);
    if (!hit) { selected = null; marker.visible = false; edgeLine.visible = false; $('info').textContent = 'Click a part.'; return; }
    selected = hit.object; selected.material = highlight;
    const d = describeHit(hit), copy = (s) => `<div class="copy" title="click to copy">${s}</div>`;
    $('info').innerHTML = `<b>${d.name}</b><br>part: ${d.def.slug}<br>size: ${dimsText(d.def.dims)}<br>type: ${d.def.type}${d.def.profile ? ` (${d.def.profile}${d.def.length ? `, parametric, cut ${d.def.length} mm` : ' library mesh'})` : ''}<br>` +
      `hit (part frame): ${d.p.map(f2).join(', ')} mm<br>` +
      (d.edge ? `edge <b>${d.edge.e.name}</b> (${f2(d.edge.d)} mm away, length ${f2(d.edge.e.length)} mm)<br>` : '') +
      (d.port && !d.edge ? `nearest port: <b>${d.port.label}</b> (${f2(d.port.d)} mm away${d.port.extra?.hole ? `, hole d${d.port.extra.hole.d}` : ''})<br>` : '') +
      (d.rail ? `rail face <b>${d.rail.face}</b>, slot ${d.rail.slot}${d.rail.onSlot ? '' : ' (hit is off the slot line)'}, <b>${d.rail.at}</b> mm from end_a<br>` : '') +
      '<br>JSON refs (click to copy):' + d.refs.map(copy).join('') + copy(`"${d.name}"`);
    $('info').querySelectorAll('.copy').forEach((el) => (el.onclick = () => navigator.clipboard?.writeText(el.textContent.replace(/^"|"$/g, (m) => m)).catch(() => {})));
    edgeLine.visible = false;
    if (d.edge) {
      const inst = res.instances.find((i) => i.name === d.name), e = d.edge.e, h = e.length / 2;
      const a = m4.point(inst.M, e.origin.map((c, k) => c - e.x[k] * h)), b = m4.point(inst.M, e.origin.map((c, k) => c + e.x[k] * h));
      edgeLine.geometry.setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]); edgeLine.visible = true; marker.visible = false;
    } else if (d.port && $('b-ports').checked) {
      const inst = res.instances.find((i) => i.name === d.name), w = m4.point(inst.M, d.port.o);
      marker.position.set(...w); marker.scale.setScalar(1.8); marker.visible = true;
    } else marker.visible = false;
    window.__viewer.lastHit = d.refs; window.__viewer.lastSel = d.sel;
    if (!silent) prompt.pick(d.sel);
  }

  // ---- chips <-> 3D: resolve a ref, hover glow, click = select + frame ----
  const hoverMat = stage.surface(new THREE.MeshStandardMaterial({ color: 0xffd34d, emissive: 0x996600, roughness: 0.4 }));
  const hoverMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0x0090b0, depthTest: false }));
  hoverMarker.renderOrder = 22; hoverMarker.visible = false;
  const hoverLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]), new THREE.LineBasicMaterial({ color: 0xff6a00, depthTest: false }));
  hoverLine.renderOrder = 23; hoverLine.visible = false; hoverLine.frustumCulled = false;
  let hovered = null;
  /** ref -> {inst, mesh, color, kind, point?, edge?} ; null = does not exist now ; undefined = nothing solved yet */
  function resolveRef(ref) {
    if (!res) return undefined;
    const dot = ref.indexOf('.'), path = dot < 0 ? ref : ref.slice(0, dot), inst = res.instances.find((i) => i.name === path), mesh = inst && meshes.get(path);
    if (!inst || !mesh) return null;
    const out = { inst, mesh, color: '#' + new THREE.Color(colorOfType(inst.def.type)).getHexString() };
    if (dot < 0) return out;
    try {
      const p = findPort(inst.def, ref.slice(dot + 1));
      out.point = m4.point(inst.M, p.origin);
      if (/^edge_/.test(p.name)) { const h = p.length / 2; out.edge = [m4.point(inst.M, p.origin.map((c, k) => c - p.x[k] * h)), m4.point(inst.M, p.origin.map((c, k) => c + p.x[k] * h))]; }
    } catch (e) { return null; }
    return out;
  }
  const restoreMat = (mesh) => { const i = res.instances.find((q) => q.name === mesh.userData.name); if (i) mesh.material = mesh === selected ? highlight : matFor(i.def.type); };
  function hover(ref) {
    if (hovered) { restoreMat(hovered); hovered = null; }
    hoverMarker.visible = hoverLine.visible = false;
    const r = ref && active ? resolveRef(ref) : null;
    if (!r) return;
    hovered = r.mesh; r.mesh.material = hoverMat;
    if (r.edge) { hoverLine.geometry.setFromPoints(r.edge.map((q) => new THREE.Vector3(...q))); hoverLine.visible = true; }
    else if (r.point) { hoverMarker.position.set(...r.point); hoverMarker.scale.setScalar(2.2); hoverMarker.visible = true; }
  }
  const flyTo = (box) => stage.flyTo(box, 40);
  function focus(ref) {
    const r = resolveRef(ref); if (!r) return;
    const box = new THREE.Box3();
    if (r.edge) r.edge.forEach((q) => box.expandByPoint(new THREE.Vector3(...q)));
    else if (r.point) box.expandByPoint(new THREE.Vector3(...r.point));
    else box.setFromObject(r.mesh);
    if (r.point) box.expandByScalar(15);
    let pt = r.point ? new THREE.Vector3(...r.point) : box.getCenter(new THREE.Vector3());
    if (!r.point) { const { min, max } = r.inst.def.bbox || { min: [0, 0, 0], max: [0, 0, 0] }; pt = new THREE.Vector3(...m4.point(r.inst.M, [0, 1, 2].map((k) => (min[k] + max[k]) / 2))); }
    hover(null);
    show({ object: r.mesh, point: pt }, true);
    window.__viewer.lastFocus = ref;
    flyTo(box);
  }
  const prompt = createPrompt({ $, getResult: () => res, getFile: () => file, hooks: { resolve: resolveRef, hover, focus } });
  const ray = new THREE.Raycaster();
  const hitAt = (cx, cy) => { ray.setFromCamera(ndc(cx, cy), camera); return ray.intersectObjects(group.children, false)[0]; };
  addEventListener('pointermove', (e) => {
    const tip = $('tip');
    if (!active || e.target !== renderer.domElement || !res) { tip.hidden = true; return; }
    const h = hitAt(e.clientX, e.clientY);
    if (!h) { tip.hidden = true; return; }
    tip.hidden = false; tip.textContent = h.object.userData.name; tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY + 12 + 'px';
  });

  let active = false;
  async function enter(initialFile) {
    active = true;
    scene.add(group, marker, edgeLine, hoverMarker, hoverLine); $('pr-dock').hidden = false;
    await open(initialFile || file || 'plotter.json');
  }
  function leave() { hover(null); active = false; $('pr-dock').hidden = true; scene.remove(group, marker, edgeLine, hoverMarker, hoverLine); $('tip').hidden = true; }
  async function open(f) {
    file = f; overrides = {}; renderPanel.sig = null; rebuild.names = null; framed = null;
    asm = await loader.assembly(f).catch((e) => { $('b-err').textContent = 'ERROR: ' + e.message; return null; });
    if (!asm) return;
    await rebuild(false);
    ctx.onOpen?.(f);
  }

  // live reload: any change to assemblies/*.json re-reads the current file (sub-assemblies included: reload on any file)
  const reload = async () => {
    if (!active || !file) return;
    try { asm = await loader.assembly(file); } catch (e) { $('b-err').textContent = 'ERROR: ' + e.message; return; } // JSON syntax errors land here
    rebuild.names = null; renderPanel.sig = null;
    await rebuild(true);
    window.__viewer.reloads = (window.__viewer.reloads || 0) + 1;
  };
  if (import.meta.hot) import.meta.hot.on('assemblies-changed', (d) => { reload().catch(console.error); });

  return { prompt, group, bomText: () => `Bill of materials: ${file} (${res?.instances.length} instances)\n` + bomLines.join('\n'), enter, leave, hitAt, show, isActive: () => active, setState: (s) => { Object.assign(overrides, s); return rebuild(true); }, get result() { return res; } };
}
