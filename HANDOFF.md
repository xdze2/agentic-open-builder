# Handoff: OpenBuilds pen plotter virtual assembly

Last session: 2026-11-12. Read `proposal.md` first: it holds the architecture (parts with ports → assembly JSON → three.js viewer).

## Goal

Build an assembled 3D model of a pen plotter made from OpenBuilds modules, before buying hardware: check fit, axis travel and collisions, and produce a bill of materials.

Design idea (sizes not final):
- X axis: V-slot 20x60 rail, 4-wheel horizontal carriage (20-80mm gantry plate)
- Y axis: V-slot 20x20 rail cantilevered on the X carriage, 4-wheel vertical carriage holding the pen
- NEMA17 motors (the user's motor is the **40 mm body NEMA17**: the assembly must use library part `nema17-40`, not the 48 mm `nema-17-stepper-motor`), GT2 belts; pen lift not designed yet (probably a servo)

## Decisions so far

- **Parts are hybrid:** real meshes from OpenBuilds STEP files for the hardware (plates, wheels, motor, pulleys), and parametric JS for variable-length parts (V-slot cut to length, belt).
- **Ports:** each port is a frame (origin, Z = out of the mating face, X = reference axis). A mate puts port A face to face with port B, with an optional rotation about Z and an optional offset. The mates form a tree from a root part, so no constraint solver is needed. A `joint` (prismatic) on a mate makes it a moving axis driven by `state` variables. See the JSON example in `proposal.md` §2.
- **Stack:** Node 22, JS, three.js viewer (Vite planned), no backend. Python/CadQuery is not used for now.

## Current state

```
proposal.md          design proposal (§6 = STEP sources, §7 = open questions)
parts/               GrabCAD downloads: *.zip + one extracted folder each (untrusted data, never run anything there)
tools/step2glb.mjs   STEP → GLB converter (occt-import-js 0.0.23 + @gltf-transform/core 4.5.1)
tools/convert_all.mjs  converts all 9 STEP files  (npm run convert)
tools/verify.mjs     reloads GLBs, checks node counts vs catalog  (node tools/verify.mjs models/*)
models/<name>/       assembly.glb, catalog.json, parts/<slug>__<n>.glb   (10 MB total)
```

```
viewer/              Vite + three.js viewer (index.html, main.js, vite.config.js)
```

Viewer: `npm install`, then `npm run dev` (http://localhost:5173) or `npm run build` (-> viewer/dist, copies assembly.glb + catalog.json of each model). `vite.config.js` serves `models/` at `/models` via a dev middleware and builds the picker list from the folders at dev/build time (virtual module `virtual:models`; restart dev after adding a model). Features: model picker, orbit, auto-frame, click-to-select (name, type, bbox size/centre in mm), world/part axes and grid toggles (grid step shown bottom-left), colour by part type (name regex table `TYPES` at the top of `viewer/main.js`, first match wins: rail, plate, wheel, motor, pulley, belt, fastener, other). Scene is Z-up like the STEP data. Catalog entries are matched to GLB nodes by `name__instance` with non-alphanumerics stripped (GLTFLoader sanitises names). Checked with headless Chrome only for load (47 parts, no console errors) and one screenshot; click selection was not tested automatically. Part-axes gizmo uses the mesh's own frame, which is the assembly frame until parts are re-centred.

Converted models:

| models/ folder | Content | Parts |
|---|---|---|
| actuator_2060_500 | NEMA17 belt-and-pinion actuator: 20x60x500 rail, 20-80 gantry plate, 4 solid V wheels, spacers, motor mount, GT2 20T pulley, GT2 belt 585mm | 47 |
| actuator_nema23_2060_500 | NEMA23 belt-driven actuator: adds idler pulley plate, smooth idler wheel, spacer blocks, GT3 belt | 75 |
| openrail_gantry_kit | OpenRail 60mm plate + 4 Delrin V wheels + hardware (real assembly tree in the STEP) | 29 |
| vslot_2060_1000, gantry_plate_20_80, nema17, motor_mount_nema17, limit_switch_plate, openrail_plate_40 | single parts | 1 each |

## Things to know about the converted data

- **Units are mm.** Nothing was rescaled.
- **Per-part GLBs are in assembly coordinates, not re-centred.** Axis directions differ between files: the rail runs along Y in the actuator but along Z in the standalone 1000mm file; the motor axis is along X in the actuator but along Z standalone. The next step is to give each reusable part its own origin and orientation (and the removed offset becomes the port position on the parent).
- **Names in the two flattened actuators** come from `MANIFOLD_SOLID_BREP` order in the STEP file, because occt returns empty names there. The geometry is consistent with that mapping, but it is an assumption.
- **Colours are mostly white** (no colour in the STEP files). Colour by part type in the viewer.
- **Same name, different sizes:** `Low Profile Screw M5` exists at 11.5 and 26.5 mm, and `Nylon Insert Lock Nut M5` (NEMA23 actuator) also comes in two sizes. The catalog doesn't separate them; use bbox dims.
- **OpenRail kit:** each instance is expanded into its own mesh, so geometry is duplicated.
- `parts/openrail-gantry-kit-1.snapshot.2/OpenRail Gantry Kits.png` is actually JPEG 2000. Ignore it.

## Step 2 done: parts library (2026-11-12)

`npm run library` (tools/build_library.mjs, helpers in tools/lib_mesh.mjs) reads `models/` only and writes `library/` (2 MB, tracked): `index.json` + `<slug>/part.glb` + `<slug>/part.json`. 157 solids -> **34 unique parts** (wheel 2, motor 2, plate 7, screw 7, spacer 4, pulley 3, tee_nut 2, rail 2, shim 2, bearing 1, nut 1, block 1); the 2 belts are skipped (parametric).

- **Dedupe key:** same name + type + fingerprint within 0.15 mm. Triangle count is NOT in the key (occt tessellates each instance differently, e.g. 504 vs 596 triangles for identical screws). Fingerprint = sorted bbox dims, but for axial parts (wheel, pulley, spacer, bearing, shim, nut) = [axis length, circumradius], because the bbox of a hex nut changes with its rotation. Same name with different sizes gets a size suffix in the slug (`low-profile-screw-m5-9x9x26_5`).
- **Canonical frames** (also in `library/index.json` `frameRules`; `part.json` `transform` holds rotation + origin, `local = R (source - origin)`, so step 3 can map assembly coordinates to part frames):
  axial parts Z axis at bbox centre (headed/flanged end toward -Z); screws length = Z, head at -Z; plates thickness = Z, longest side = X, origin at plate centre on the back face (front face at z = thickness); motor shaft = +Z, origin at mounting-face centre; rail length = Z from one end centre, 60 side = X; block longest = Z. Gantry plate and motor mount plate frames are forced (`OVERRIDES`): local Z = +X of the actuator_2060_500 assembly, i.e. the front face is the wheel side of the gantry plate and the gantry-facing side of the mount plate.
- **Ports** (`{name, origin, z, x}` in the part frame, y = z cross x): gantry plate `wheel_1..4` (+x+y, -x+y, -x-y, +x-y; hole centres measured from the mesh boundary loops on the front face; 5.1 mm holes at x=+39.85 and 7.1 mm eccentric holes at x=-39.85, rectangle 79.7 x 60.64), `center`, `center_back`, `motor_mount` (back face, x=62.65); solid V wheel `center`, `axle_front`, `axle_back`; NEMA17 `face`, `shaft` (tip z=24), `hole_1..4` (31 mm pitch, M3, measured); motor mount plate `to_gantry` (front centre) and `motor` (back face, at the 25 mm bore, x=19.75); rails `end_a`, `end_b`. All other parts have `ports: []`.
- **Validation** (printed by the script, stored in `ports_validation`, script exits 1 on failure): wheel_N hole centres vs the 4 wheel axles in actuator_2060_500 (0.000 mm for the 2 concentric wheels, 0.79 mm for the 2 eccentric ones = the eccentric spacer offset); wheel centre sits 3 + 7.4 + 5.1 mm above the plate back face; rail centre line = plate centre line; NEMA17 axis = mount-plate bore; mount plate centre = `motor_mount` port. Wheel `axle_back` is 7.4 mm above the plate `wheel_N` port in the real assembly (spacer 6 + shim 1 + bearing stack): a mate needs that offset.
- **Viewer Parts mode:** `Assemblies | Parts` tabs. Library grouped by type, part at origin with its axes, port triads with labels (toggles for frames and labels). `library/` is served like `models/` (dev middleware) and copied to `dist/library` on build. Deep link `#parts/<slug>` (and `#parts/vslot-20x60`). Checked with headless Chrome screenshots (gantry plate, NEMA17, V-slot, wheel, mount plate; assemblies mode still loads).
- **Parametric V-slot:** `viewer/vslot.js` (20x20, 20x40, 20x60, simplified profile: T-slot notches 6.2 mm opening / 6.1 deep, 4.2 mm bores, no V chamfers), same frame as the library rails, ports `end_a`, `end_b`, `mid`. Listed under "rail (parametric)" with a length field. Dimensions are not verified against OpenBuilds drawings.
- **`nema17-40`** (user's motor): generated in build_library.mjs from the 48 mm NEMA17 by scaling only vertices with z < 0 by 40/48 (measured body 48.000 mm); face, boss, shaft and ports identical (`derivedFrom` in part.json); bbox z -40..24, `instances: 0`.
- **Not done / next:** belt generator; ports on spacers, screws, pulley, idler plate, Open Rail plates, NEMA23 parts; step 3 = assembly JSON + mate solver using `transform` and ports; real rail V-groove profile (the library rail meshes are 20x60 only; no 20x20 or 20x40 mesh exists). The part-axes gizmo in Assemblies mode still uses the assembly frame.

## Step 3 done: assemblies, solver, Build tab (2026-11-12)

Read `VOCABULARY.md` first (world axes, face/port/hole names, verbs, text -> JSON examples). Summary:

```
VOCABULARY.md              shared language (human + agent)
lib/mat.js                 4x4 rigid transforms (flat row-major arrays), no deps
lib/vslot_ports.js         V-slot profiles, faces, slot lines, lip ports; used by node, build_library and the viewer
lib/assembly.js            solver: parts / mates / mounts / sub-assemblies / joints / BOM; async, loader injected (node fs or browser fetch)
tools/solve.mjs            CLI: node tools/solve.mjs assemblies/plotter.json [--positions] [--state x=120] [--json]  (npm run solve -- ...)
assemblies/*.json          actuator_2060_500.json (37 instances, joint x), plotter.json (actuator sub-assembly + 20x20x500 beam, 2 screws + 2 tee nuts)
viewer/buildmode.js        "Build" tab (deep link #build/plotter.json)
```

- **World:** X = travel (right), Y = front/back (front = -Y = toward the viewer), Z up. Origin = centre of end_a of the X rail. Actuator pose: rail along +X, plate free (front) face to -Y, motor up (+Z). `state.x` = mm from end_a.
- **Library additions** (rebuilt by `npm run library`): rails get face / slot / lip ports from `lib/vslot_ports.js`; plates get `holes` (every circular hole, name `h_<x>_<y>`, diameter, wheel holes alias `wheel_N`) plus `front` (free face, library z=0) / `back` (wheel side, library z=t) ports; axial parts `end_a/end_b/center`; eccentric spacer `bore_a/bore_b` (0.79 mm off axis); screws `under_head/head_top/tip` (+ `headHeight` 1.5); tee nut `face_a/face_b/center`.
- **Addressing:** `inst.port`, `inst.front:h_-19.85_0` (hole by name), `inst.front@x,y` (nearest hole within 2 mm), `inst.top_slot_2@120` (120 mm from end_a). Errors name the valid choices.
- **Mount** (`mounts[]`): rail face on plate face, `direction` (world word or plate +x/-x/+y/-y), `line`, `overhang`/`end_a_at`, `fasten {with,nut,count}`: finds holes on the slot line, adds tee nuts + screws (screw from the far face of the plate), chooses the screw length from the stack (plate + gap + 1.8 lip + 3 nut + 0.8 protrusion), errors with the usable plate lines if nothing lines up.
- **Actuator rebuild vs models/actuator_2060_500:** max deviation 0.514 mm (nuts: STEP nut seats 0.5 mm off our end-to-end stack; wheel screws 0.5 mm: STEP screw head sits 0.25 mm off the plate face), all wheels/bearings/shims/spacers/rail/plate/mount < 0.04 mm. Motor is 40 mm so only the shaft tip is compared (0.000). Not modelled from the STEP: belt, the two plate-mount screws + double tee nut (M5 11.5 / Tee Nut), 4 M3 screws, 2 rail-end tee nuts. The anchor of the comparison is the gantry plate (`compare` key of the actuator JSON); the rail pose is checked relative to it.
- **Build tab:** pick file, slider per joint, instance name on hover and click (click also shows nearest port / hole and the rail face + slot + mm from end_a, with copy-ready JSON refs), BOM (rails with cut length), mount summary, live reload on save of any `assemblies/*.json` (Vite HMR custom event `assemblies-changed`, dev server only; the production build copies `assemblies/` to `dist/assemblies`). Errors (including JSON syntax errors) are shown in the panel.
- **Not done / ideas:** the motor mount plate's own screws and the rail-end tee nuts are not generated; no collision check; no belt; tee nut rotation about the slot is fixed (15 mm along the slot); `fasten` only supports a rail lying on a plate face; V-slot profile is the simplified one; the viewer has no port-triad overlay in Build mode (only a marker at the clicked port).

## Open questions (user)

- Rail and gantry plate sizes are **not decided** (user: "not sure yet which size to use"). The parts library must make swapping sizes easy.
- V-slot 20x20 vs OpenRail for the Y axis / pen carriage. These are different systems: OpenRail wheels run on a rail fastened to a flat surface, not on the profile's V grooves.
- Missing parts: 20x20 V-slot rail, mini V gantry plate for 20x20, pen holder, pen-lift servo. Possible GrabCAD sources: "V-Slot 20x20 Linear Rail", "Mini V Gantry Set".
- Design points to check later: sag of the cantilevered Y rail, pen-lift mechanism.

## Next steps

1. (done) Minimal viewer, see above.
2. (done) Re-centre a few reusable parts (20-80 gantry plate, solid V wheel, NEMA17, motor mount) and define their ports. Start with the 4 wheel ports on the 20-80 plate, measured from the actuator file.
3. (done) Write the assembly JSON + tree solver, rebuild the X axis from parts, add the X slider.
4. Y axis, pen holder, belts, BOM (see the roadmap in `proposal.md` §4).
