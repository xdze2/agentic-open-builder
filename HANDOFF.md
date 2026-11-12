# Handoff: OpenBuilds pen plotter virtual assembly

Last session: 2026-11-12. Read `proposal.md` first: it holds the architecture (parts with ports → assembly JSON → three.js viewer).

## Goal

Build an assembled 3D model of a pen plotter made from OpenBuilds modules, before buying hardware: check fit, axis travel and collisions, and produce a bill of materials.

Design idea (sizes not final):
- X axis: V-slot 20x60 rail, 4-wheel horizontal carriage (20-80mm gantry plate)
- Y axis: V-slot 20x20 rail cantilevered on the X carriage, 4-wheel vertical carriage holding the pen
- NEMA17 motors, GT2 belts; pen lift not designed yet (probably a servo)

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

## Open questions (user)

- Rail and gantry plate sizes are **not decided** (user: "not sure yet which size to use"). The parts library must make swapping sizes easy.
- V-slot 20x20 vs OpenRail for the Y axis / pen carriage. These are different systems: OpenRail wheels run on a rail fastened to a flat surface, not on the profile's V grooves.
- Missing parts: 20x20 V-slot rail, mini V gantry plate for 20x20, pen holder, pen-lift servo. Possible GrabCAD sources: "V-Slot 20x20 Linear Rail", "Mini V Gantry Set".
- Design points to check later: sag of the cantilevered Y rail, pen-lift mechanism.

## Next steps

1. (done) Minimal viewer, see above.
2. Re-centre a few reusable parts (20-80 gantry plate, solid V wheel, NEMA17, motor mount) and define their ports. Start with the 4 wheel ports on the 20-80 plate, measured from the actuator file.
3. Write the assembly JSON + tree solver, rebuild the X axis from parts, add the X slider.
4. Y axis, pen holder, belts, BOM (see the roadmap in `proposal.md` §4).
