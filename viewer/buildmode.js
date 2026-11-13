// "Build" tab: loads assemblies/*.json, solves them with lib/assembly.js, renders the instances, sliders for joints,
// BOM, hover/click naming (instance, port, hole) and live reload (Vite HMR event 'assemblies-changed').
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { solve, AsmError, findPort } from '../lib/assembly.js';
import * as m4 from '../lib/mat.js';
import { railGeometry } from './vslot.js';
import { beltGeometry, beltClamps } from './belt.js';
import { slotsOf, FACES } from '../lib/vslot_ports.js';
import { edgePorts } from '../lib/assembly.js';
import { short, portWords } from './prompt.js';

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
    if (inst.def.parametric === 'belt') return beltGeometry(inst.def);
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
    let reselect = null;
    if (rebuild.names !== names || !meshes.size) {
      reselect = selected?.userData.name || null; // keep the selection where the name still exists
      snapshotTree();
      for (const m of [...group.children]) group.remove(m);
      meshes = new Map();
      for (const inst of res.instances) {
        const mesh = new THREE.Mesh(await geometryOf(inst), matFor(inst.def.type));
        mesh.matrixAutoUpdate = false; mesh.userData = { name: inst.name }; stage.decorate(mesh);
        if (inst.def.parametric === 'belt') beltClamps(mesh, inst.def);
        group.add(mesh); meshes.set(inst.name, mesh);
      }
      rebuild.names = names; selected = null;
      for (const n of [...hidden]) if (!meshes.has(n)) hidden.delete(n);
      buildTree(); applyVisibility();
    }
    for (const inst of res.instances) {
      const m = meshes.get(inst.name); m.matrix.copy(toMatrix(inst.M)); m.matrixWorldNeedsUpdate = true;
      if (inst.def.parametric === 'belt') { // the path follows the clamps (carriage) and the pulleys: new geometry, edges and clamp spheres
        const g = beltGeometry(inst.def);
        if (m.geometry !== g) { m.geometry = g; for (const c of m.children.filter((o) => o.userData.isEdges)) m.remove(c); m.userData.hasEdges = false; stage.decorate(m); beltClamps(m, inst.def); }
      }
    }
    group.updateMatrixWorld(true);
    renderPanel(); hover(null); prompt.refresh();
    if (reselect && meshes.has(reselect)) show({ object: meshes.get(reselect), point: centerOf(res.instances.find((i) => i.name === reselect)) }, true);
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
    $('b-bom').innerHTML = '<table>' + res.bom.map((r) => `<tr><td>${r.count} x</td><td>${r.type}</td><td>${r.belt_length ? `${r.name.split(',')[0]}, ${r.open ? 'cut length' : 'endless loop'} <b>${r.belt_length} mm</b> (parametric)` : r.cut_length ? `${r.profile || ''} V-slot rail, cut <b>${r.cut_length} mm</b>${r.parametric ? '' : ' (library mesh)'}, ${dimsText(r.dims)}` : `${r.slug} <span style="color:var(--sl-color-neutral-500)">${dimsText(r.dims)}</span>`}</td></tr>`).join('') + '</table>' +
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
  const bomText = (r) => r.belt_length ? `${r.name.split(',')[0]}, ${r.open ? 'cut length' : 'endless loop'} ${r.belt_length} mm (parametric)` : `${r.cut_length ? `${r.profile || ''} V-slot rail, cut ${r.cut_length} mm${r.parametric ? '' : ' (library mesh)'}` : r.slug}${r.cut_length ? '' : `  (${dimsText(r.dims)})`}`;
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
    if (!hit) { selected = null; marker.visible = false; edgeLine.visible = false; $('info').textContent = 'Click a part.'; treeSelect(null); return; }
    selected = hit.object; selected.material = highlight; treeSelect(selected.userData.name);
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
  const centerOf = (inst) => { const { min, max } = inst.def.bbox || { min: [0, 0, 0], max: [0, 0, 0] }; return new THREE.Vector3(...m4.point(inst.M, [0, 1, 2].map((k) => (min[k] + max[k]) / 2))); };
  const flyTo = (box) => stage.flyTo(box, 40);
  function focus(ref) {
    const r = resolveRef(ref); if (!r) return;
    const box = new THREE.Box3();
    if (r.edge) r.edge.forEach((q) => box.expandByPoint(new THREE.Vector3(...q)));
    else if (r.point) box.expandByPoint(new THREE.Vector3(...r.point));
    else box.setFromObject(r.mesh);
    if (r.point) box.expandByScalar(15);
    const pt = r.point ? new THREE.Vector3(...r.point) : centerOf(r.inst);
    hover(null);
    show({ object: r.mesh, point: pt }, true);
    window.__viewer.lastFocus = ref;
    flyTo(box);
  }
  const prompt = ctx.prompt; // shared with the other views (main.js); its hooks call back into resolveRef / hover / focus below
  const ray = new THREE.Raycaster();
  const hitAt = (cx, cy) => { ray.setFromCamera(ndc(cx, cy), camera); return ray.intersectObjects(group.children.filter((m) => m.visible), false)[0]; }; // hidden pieces are not pickable
  addEventListener('pointermove', (e) => {
    const tip = $('tip');
    if (!active || e.target !== renderer.domElement || !res) { tip.hidden = true; return; }
    const h = hitAt(e.clientX, e.clientY);
    if (!h) { tip.hidden = true; return; }
    tip.hidden = false; tip.textContent = h.object.userData.name; tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY + 12 + 'px';
  });

  // ---- Structure tree: root assembly > sub-assemblies > instances (generated fasteners in a collapsed group) ----
  const hidden = new Set();          // hidden instance names (kept across live reloads where the name still exists)
  const expState = new Map();        // tree key -> expanded
  const items = new Map(), groupNames = new Map(); // key -> sl-tree-item ; group key -> instance names below it
  const treeEl = $('b-tree'), esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let syncing = false, hoverKey = null;
  const hex = (t) => '#' + new THREE.Color(colorOfType(t)).getHexString();
  const detailOf = (d) => (d.parametric === 'belt' ? `${d.slug}, ${d.closed ? 'loop' : 'cut'} ${d.length.toFixed(1)} mm` : d.profile ? `${d.profile} V-slot, ${+(d.length ?? d.dims[2]).toFixed(1)} mm` : d.slug);
  const ACT = (act, icon, tip) => `<sl-icon-button name="${icon}" data-act="${act}" label="${tip}" title="${tip}"></sl-icon-button>`;
  function snapshotTree() { if (treeEl.dataset.filtering) return; for (const [k, it] of items) if (it.dataset.group) expState.set(k, it.expanded); }
  function buildTree() {
    items.clear(); groupNames.clear();
    const mountNames = new Set(res.mounts.map((m) => m.name));
    const root = { key: 'g:root', label: file.replace(/\.json$/, ''), kids: [], root: true }, fast = { key: 'g:fasteners', label: 'Fasteners', kids: [], dflt: false, note: 'generated screws and tee nuts' };
    const groups = new Map([['', root]]);
    const groupAt = (path) => { // path of segments
      const k = path.join('/'); if (groups.has(k)) return groups.get(k);
      const parent = groupAt(path.slice(0, -1)), g = { key: 'g:' + k, label: path[path.length - 1], kids: [] };
      groups.set(k, g); parent.kids.push(g); return g;
    };
    for (const inst of res.instances) {
      const seg = inst.name.split('/'), dir = seg.slice(0, -1).join('/');
      (mountNames.has(dir) ? fast : groupAt(seg.slice(0, -1))).kids.push({ key: inst.name, inst, label: seg[seg.length - 1] });
    }
    if (fast.kids.length) root.kids.push(fast);
    const names = (n) => (n.inst ? [n.key] : n.kids.flatMap(names));
    const html = (n) => {
      if (n.inst) {
        const d = n.inst.def;
        return `<sl-tree-item data-key="${esc(n.key)}" data-leaf="1"><span class="tn"><i class="sw" style="background:${hex(d.type)}"></i><span class="nm">${esc(n.label)}</span><span class="dt">${esc(detailOf(d))}</span><span class="ta">${ACT('ins', 'plus-square', 'Insert in prompt')}${ACT('eye', 'eye', 'Hide / show (shift-click: isolate)')}</span></span></sl-tree-item>`;
      }
      groupNames.set(n.key, names(n));
      const open = expState.has(n.key) ? expState.get(n.key) : n.dflt !== false;
      return `<sl-tree-item data-key="${n.key}" data-group="1" ${open ? 'expanded' : ''}><span class="tn"><sl-icon name="${n.root ? 'diagram-3' : 'box'}"></sl-icon><span class="nm">${esc(n.label)}</span><span class="dt">${n.note ? esc(n.note) + ', ' : ''}${groupNames.get(n.key).length}</span><span class="ta">${ACT('eye', 'eye', 'Hide / show this group (shift-click: isolate)')}</span></span>${n.kids.map(html).join('')}</sl-tree-item>`;
    };
    syncing = true;
    treeEl.innerHTML = html(root);
    for (const it of treeEl.querySelectorAll('sl-tree-item')) items.set(it.dataset.key, it);
    syncing = false;
    filterTree();
  }
  function applyVisibility() {
    for (const [n, m] of meshes) m.visible = !hidden.has(n);
    stage.refreshShadows();
    for (const [k, it] of items) {
      const ns = it.dataset.leaf ? [k] : groupNames.get(k) || [], off = ns.length > 0 && ns.every((n) => hidden.has(n));
      const some = ns.some((n) => hidden.has(n)), b = it.querySelector(':scope > .tn [data-act="eye"]');
      it.classList.toggle('off', off); it.classList.toggle('part-off', !off && some);
      if (b) b.name = off ? 'eye-slash' : 'eye';
    }
  }
  const namesOf = (key) => (key.startsWith('g:') ? groupNames.get(key) || [] : [key]);
  function setHidden(key, hide) { for (const n of namesOf(key)) hide ? hidden.add(n) : hidden.delete(n); applyVisibility(); }
  function isolate(key) { hidden.clear(); const keep = new Set(namesOf(key)); for (const n of meshes.keys()) if (!keep.has(n)) hidden.add(n); applyVisibility(); }
  function treeSelect(name) {
    const it = name ? items.get(name) : null;
    syncing = true;
    for (const x of treeEl.querySelectorAll('sl-tree-item[selected]')) if (x !== it) x.selected = false;
    if (it) {
      if (it.hidden) { $('tree-q').value = ''; filterTree(); }
      for (let p = it.parentElement; p && p.tagName === 'SL-TREE-ITEM'; p = p.parentElement) p.expanded = true;
      it.selected = true;
      requestAnimationFrame(() => it.scrollIntoView({ block: 'nearest' }));
    }
    setTimeout(() => (syncing = false), 0);
  }
  function filterTree() {
    const q = $('tree-q').value.trim().toLowerCase();
    if (q && !treeEl.dataset.filtering) { snapshotTree(); treeEl.dataset.filtering = '1'; }
    const lastFiltering = !!q;
    const vis = (it) => { // returns true when it (or a descendant) matches
      const kids = [...it.querySelectorAll(':scope > sl-tree-item')];
      const self = !q || (it.dataset.key + ' ' + it.textContent).toLowerCase().includes(q);
      const any = kids.map(vis).some(Boolean);
      it.hidden = !(self || any);
      if (it.dataset.group && q) it.expanded = any;
      return self || any;
    };
    syncing = true;
    treeEl.querySelectorAll(':scope > sl-tree-item').forEach(vis);
    if (!lastFiltering && treeEl.dataset.filtering) { delete treeEl.dataset.filtering; for (const [k, it] of items) if (it.dataset.group && expState.has(k)) it.expanded = expState.get(k); }
    setTimeout(() => (syncing = false), 0);
  }
  $('tree-q').addEventListener('sl-input', filterTree);
  const selName = () => selected?.userData.name || null;
  $('tree-iso').addEventListener('click', () => { const n = selName(); if (n) isolate(n); });
  $('tree-all').addEventListener('click', () => { hidden.clear(); applyVisibility(); });
  const keyOf = (e) => e.target.closest?.('sl-tree-item')?.dataset.key;
  treeEl.addEventListener('click', (e) => { // item action buttons (capture: the tree must not treat them as a row click)
    const b = e.target.closest?.('[data-act]'); if (!b) return;
    e.stopPropagation();
    const key = keyOf(e), n = namesOf(key);
    if (b.dataset.act === 'eye') { if (e.shiftKey) isolate(key); else setHidden(key, !n.every((x) => hidden.has(x))); }
    else if (b.dataset.act === 'ins') { const inst = res.instances.find((i) => i.name === key); if (inst) { prompt.insertChip({ ref: key, label: short(key) }); ctx.afterTreePick?.(); } }
  }, true);
  treeEl.addEventListener('sl-selection-change', (e) => {
    const it = e.detail.selection[0]; if (syncing || !it?.dataset.leaf || it.dataset.key === selName()) return;
    focus(it.dataset.key); ctx.afterTreePick?.(); // same code path as a chip click: select, info, camera fly
  });
  treeEl.addEventListener('mouseover', (e) => { const k = e.target.closest?.('sl-tree-item[data-leaf]')?.dataset.key || null; if (k !== hoverKey) { hoverKey = k; hover(k); } });
  treeEl.addEventListener('mouseleave', () => { hoverKey = null; hover(null); });

  let active = false;
  async function enter(initialFile) {
    active = true;
    scene.add(group, marker, edgeLine, hoverMarker, hoverLine);
    await open(initialFile || file || 'plotter.json');
  }
  function leave() { hover(null); active = false; scene.remove(group, marker, edgeLine, hoverMarker, hoverLine); $('tip').hidden = true; }
  async function open(f) {
    file = f; overrides = {}; renderPanel.sig = null; rebuild.names = null; framed = null;
    selected = null; hidden.clear(); expState.clear(); marker.visible = edgeLine.visible = false; $('info').textContent = 'Click a part.';
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

  return { resolveRef: (ref) => (active ? resolveRef(ref) : undefined), hover, focus, state: () => res?.state, file: () => file, group, bomText: () => `Bill of materials: ${file} (${res?.instances.length} instances)\n` + bomLines.join('\n'), enter, leave, hitAt, selOf: (h) => describeHit(h).sel, show, isActive: () => active, setState: (s) => { Object.assign(overrides, s); return rebuild(true); }, get result() { return res; } };
}
