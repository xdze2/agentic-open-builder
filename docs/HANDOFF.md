# Handoff: OpenBuilds pen plotter virtual assembly

Last session: 2026-11-13. Read this file, then `docs/VOCABULARY.md` (the shared language for assemblies). `docs/proposal.md` holds the original architecture and STEP sources.

## Goal

Build an assembled 3D model of a pen plotter made from OpenBuilds parts, before buying hardware. Use it to check fit, axis travel and collisions, and to get a bill of materials.

## How we work (user preferences)

- **The viewer is for looking and pointing; it never edits geometry.** The user explicitly does not want to drift into a CAD program. The AI agent edits `user_data/assemblies/*.json`, and the viewer live-reloads.
- **Loop:**
  1. Open an assembly, type the request in the prompt box and click pieces in 3D to insert chips.
  2. Optionally add screenshots, press **Send** and paste the copied `Read user_data/prompts/<stamp>/prompt.md` line into Claude Code.
  3. The agent edits the JSON and checks it with `node tools/solve.mjs <file>`.
  4. The view updates.
  
  The first real test ("move the beam until the mount") worked; the user found it "works well, and simple".
- Agent = Claude Code only, no API. Mistral may come later, which would need a benchmark: plain-text requests + expected `solve.mjs` results.
- Prompt transport: **Send** POSTs to the dev server (`/api/prompt`, `/api/shot` in vite.config.js), which writes one folder per prompt in `user_data/prompts/` (prompt.md + prompt.json + PNGs); only a short `Read …` line goes through the clipboard. Images stay PNG files on disk (not base64) so the agent can see them. **Copy text** keeps the old clipboard-only path. The camera button freezes the view for drawing (viewer/sketch.js, SVG marks: select/edit, point at, move arrow, box, freehand, text); the prompt stays usable while drawing and a mark badge click inserts a chip for that mark; each mark is listed in prompt.md with the parts and 3D points under it.
- The user likes big work delegated to subagents to save tokens. Commit only when asked.

## Current design (`user_data/assemblies/plotter.json`)

- **Table-top layout.** The actuator lies flat: X rail on the table, gantry plate facing up, motor at the back (+Y). `place.orient {z:+Y, x:+X}` on the plotter root.
- **Actuator** (`user_data/assemblies/actuator_2060_500.json`): NEMA17 belt-and-pinion, 20x60x500 rail, 20-80 gantry plate, 4 solid V wheels, motor mount plate, GT2 20T pulley. The motor is the user's **40 mm NEMA17 (`nema17-40`)**. Prismatic joint `x` (40..460 mm).
- **Beam:** 20x20 V-slot, 500 mm (parametric), bolted flat on the gantry plate's free face, sticking out toward the front (-Y) over the paper.
  - Its end butts against the motor mount plate edge: `end_a_at: -21.65` (computed by hand: mount centre y 62.65 - 41).
  - Overhang is 414.85 mm. It is held by 2 M5x11.5 low-profile screws + drop-in tee nuts, in holes `h_10_0` and `h_-49.85_0` (the latter is a 7.1 mm eccentric hole).
- `node tools/solve.mjs user_data/assemblies/plotter.json` prints the BOM (42 instances) and the mount details.

## Repository map

```
docs/                  HANDOFF.md (this file), VOCABULARY.md, proposal.md, screenshots/ (README images)
docs/VOCABULARY.md     world axes, part/face/edge/hole/port names, mount verbs, text -> JSON examples, "how to talk to the agent"
docs/proposal.md       original design proposal (STEP sources, open questions)
lib/paths.js           where the private data lives: user_data/ (override with USER_DATA=<dir>)
lib/mat.js             4x4 rigid transforms (row-major), no deps
lib/vslot_ports.js     V-slot profiles, face / slot / lip ports (node + browser)
lib/assembly.js        solver: parts, mates, mounts (auto screws + tee nuts), sub-assemblies, joints, BOM, edge ports
tools/step2glb.mjs     STEP -> GLB (occt-import-js 0.0.23 + @gltf-transform/core 4.5.1); also STL (several files -> one model, one solid per file, per-face normals); convert_all.mjs = npm run convert
tools/verify.mjs       checks converted GLBs against their catalog
tools/build_library.mjs  npm run library: user_data/models/ -> user_data/library/ (unique re-centred parts + nema17-40), ports, port validation
tools/solve.mjs        CLI: node tools/solve.mjs <file> [--positions] [--state x=120] [--json]
tools/snap.mjs         headless snapshots + thumbnails (see Snapshots)
viewer/                Vite + three.js + Shoelace: index.html (layout, light CSS), main.js (browser, parts/models, snap API), stage.js (ortho camera, lights/shadows, grid, zoom), buildmode.js (assembly view), prompt.js (prompt box), sketch.js (draw on the frozen view for screenshots), vslot.js, vite.config.js

user_data/             PRIVATE, gitignored as a whole (CAD licences; personal designs)
  inbox/               raw downloads (zips)
  parts/               unpacked GrabCAD / Printables STEP/STL. UNTRUSTED: never run or import anything there
  models/<name>/       converted STEP models: assembly.glb, catalog.json, parts/*.glb, thumb.png
  library/             index.json (+ frameRules), <slug>/part.glb + part.json (dims, transform, ports, holes) + thumb.png, _thumbs/vslot-*.png
  assemblies/*.json    actuator_2060_500.json, plotter.json; _thumbs/<name>.png
  snaps/               tools/snap.mjs output
```

Run with `npm install` then `npm run dev` (http://localhost:5173), or `npm run build` (-> viewer/dist).

## Viewer

UI is Shoelace (`@shoelace-style/shoelace` 2.20.1, light theme, cherry-picked imports in `viewer/main.js`; icons are served at `/shoelace/assets/icons` by `vite.config.js` and copied to dist). Layout:

- **Left: browser** (collapsible; a drawer under 900 px). Tabs **Parts** / **Assemblies** (`user_data/assemblies/*.json`) / **STEP models** (converted `user_data/models/`), each with a search box and thumbnail cards in collapsible groups (state in localStorage `ob_groups_v1`; a search expands the groups with matches). Card = thumb, name, size (`16 × 15.9 × 5 mm`). Rails = one card per parametric profile (20x20, 20x40, 20x60); opening one shows a length bar (250/500/750/1000/1500 + custom mm) above the 3D view. The fixed-length STEP rail meshes get no card (assemblies still use them; `#parts/<slug>` still opens them). Missing thumb -> placeholder icon.
- **Centre: 3D view** with a slim top bar (browser toggle, title, **Bill of materials** button for assemblies, panel toggle). The prompt box sits at the bottom of the 3D view (assemblies only).
- **Right: details panel** (collapsible; a drawer when narrow), assembly and part info only: **Structure** (assemblies), Selection (copy-ready refs), Joints (sl-range), Mounts. No display options here. The BOM is a modal (sl-dialog) with "Copy as text". Solve errors show as a red banner over the 3D view.
- **3D view** (`viewer/stage.js`): **orthographic only**. The frustum is in pixels, so `camera.zoom` = px per mm; near/far are generous and the camera sits at a constant 5000 mm. Fixed world-spaced grid: 10 mm minor / 100 mm major, +-1500 mm around the world origin (only Z follows the item; lines fade when too dense). Overlay top-right: one toolbar with zoom in/out, fit, Iso/Top/Front/Right and a **View** `sl-dropdown` holding all display toggles (world axes, selected part axes, grid, shadows, edge lines, clicked port marker (build), port frames/labels (part), the grid hint). Toggle state in localStorage `ob_view_v1` (not applied in snap mode); top-left: scale bar. Wheel zooms smoothly toward the cursor (own handler; OrbitControls only keeps touch pinch).
- **Shading**: world-fixed key directional light with a PCF-soft shadow map fitted to the item's bounding sphere (`fitScene(box)`), hemisphere + fill lights, NeutralToneMapping, ShadowMaterial ground plane, 30 deg edge-line overlay (Display toggles: Shadows, Edge lines). The shadow map is only re-rendered on `fitScene` (`renderer.shadowMap.autoUpdate=false`); call `stage.refreshShadows()` if you move meshes elsewhere. Materials use polygonOffset so the edge lines sit on the faces.
- **Parametric rails** render the real library STEP profile stretched in Z (`railGeometry` in `vslot.js`; the library rails are pure extrusions); the simplified generated profile is only the fallback. Ports/picking come from `lib/vslot_ports.js`.
- Click tolerances (mm in the part frame): plate edge 4, port/hole 5, widened to about 6 / 8 screen px when zoomed out (caps 10 / 12 mm).
- Deep links: `#parts/<slug>` (or `vslot-20x60`), `#assemblies/<file.json>` (legacy `#build/<file>` still works), `#models/<name>`. Default: `plotter.json`.
- Live reload of `user_data/assemblies/*.json` on save (dev server only). Pick priority: plate edge, else port/hole, else the instance.
- **Prompt box** (`viewer/prompt.js`):
  - A 3D click inserts a chip at the caret.
  - Recent strip (last 5, newest left), `@` completion, Copy / Clear.
  - Chips carry the exact JSON ref (`data-ref`), a kind icon (part ◼ face ▱ edge ╱ hole ○ port ⊕), and a tint of the part colour (checked for contrast on the light theme).
  - Hover a chip -> the piece glows. Click a chip -> select + camera fly.
  - Stale refs turn grey after an edit.
  - Draft in localStorage `ob_prompt_draft_v1`.
- **Structure tree** (`buildmode.js`, `sl-tree selection="leaf"`): root assembly > sub-assemblies (from the `a/b` instance-name prefix) > instances, with a swatch (part tint), name and part/profile + cut length. Generated mount fasteners (instances under a mount name) sit in a collapsed "Fasteners" group. Row click = `focus(name)` (same path as a chip click: select, info, camera fly); a 3D click calls `treeSelect` (expands parents, scrolls into view). Hover glows the piece. Per row: insert-in-prompt (`prompt.insertChip({ref: name, label})`, same ref as a 3D click) and an eye (shift-click = isolate); header: filter, Isolate (selected instance), Show all. Hidden meshes are `visible=false` and filtered out of `hitAt`, so they cannot be picked. On live reload the tree is rebuilt; expansion (`expState`), hidden set and the selection are kept where the names still exist. Not done: flat tree for STEP models.
- Resizing the window keeps the zoom (px/mm); `fit` recomputes it.
- The Z-up camera fix: `camera.up` must be set **before** OrbitControls is created.

## Snapshots and thumbnails (headless)

`tools/snap.mjs` drives `/usr/bin/google-chrome` (puppeteer-core 25.13.0, SwiftShader WebGL, no bundled browser) against a Vite dev server it starts itself on a free port (or `--url http://localhost:5173`). The viewer has a minimal render mode `?snap=1` (no UI, light background, camera framed on the bounding box); `window.__snapLoad(target, view)` loads an item and sets `window.__snapReady = true` after one rendered frame. The tool waits on that flag, never on sleeps. Manual URL form: `/?snap=1&view=top&state=x=120#user_data/parts/<slug>`.

```
node tools/snap.mjs user_data/assemblies/plotter.json --view iso,top,front [--state x=120] [--size 1000x700] [--out dir]   # -> user_data/snaps/; prints paths
node tools/snap.mjs part <slug> [--view ...]           # slug may be vslot-20x60
node tools/snap.mjs model <name>
npm run thumbs                                         # = node tools/snap.mjs --thumbs [--force]
```

Views: iso top bottom front back right left. `--no-axes`, `--no-grid`, `--len <mm>` (parametric rails) available. Thumbs (256x256, one browser for all, skipped when newer than their source unless `--force`) go to `user_data/library/<slug>/thumb.png` and `user_data/library/_thumbs/vslot-*.png` (parametric profiles at 500 mm), `user_data/assemblies/_thumbs/<name>.png`, `user_data/models/<name>/thumb.png`. `npm run library` keeps existing thumbs; run `npm run thumbs` afterwards for new slugs.

**Agent loop:** edit `user_data/assemblies/*.json` -> `node tools/solve.mjs <file>` (numbers) -> `node tools/snap.mjs user_data/assemblies/<file> --view iso,top` and look at the PNGs (Read tool) -> repeat. Errors from the solver are printed as warnings by snap.mjs.

## Key technical facts

- **Units and world:** mm everywhere. World: X = rail travel (right), Y = front/back (front = -Y, toward the viewer), Z = up. Origin = centre of `end_a` of the X rail.
- **Library frames:**
  - Axial parts: axis along Z.
  - Plates: thickness along Z, long side along X, origin at plate centre.
  - Motor: shaft +Z, origin at the mounting face.
  - Rails: length along Z from `end_a`.
- **Library dedupe:** by name + type + shape within 0.15 mm (not triangle count). Same-name parts of different size get a size suffix, e.g. `low-profile-screw-m5-9x9x11_5`.
- **Addressing** (see VOCABULARY.md):
  - `inst.port`
  - `inst.front:h_-19.85_0`
  - `inst.front@x,y` (nearest hole within 2 mm)
  - `inst.top_slot_2@120` (mm from `end_a`)
  - `inst.edge_+y`; plate edges only, plate-local, so gantry plate `+y` = world right in the base pose
- **Plate faces:** `front` = free face, `back` = wheel side. The old library port names `center`/`center_back` say it the other way round; trust `front`/`back`.
- **Actuator rebuild accuracy:** within 0.51 mm of the STEP model (wheel nuts/screws). Everything else is < 0.04 mm.
- **Data caveats:**
  - Names in the flattened actuators come from STEP solid order (an assumption).
  - Colours are by type, not from the STEP.
  - The V-slot profile is simplified and not checked against OpenBuilds drawings.

## Not done / known gaps

- **No "touch" / contact vocabulary.** "Move X until it touches Y" had to be computed by hand. Proposed: `"end_a_at": {"touch": "actuator/mount.edge_-x"}`, so the solver computes it and it follows when Y moves.
- Not generated: motor mount plate screws + double tee nut, rail-end tee nuts, belt.
- No collision check.
- Ports missing on NEMA23 parts, OpenRail plates, idler plate.
- No rail long edges.
- Tee nut rotation is fixed.
- `fasten` only supports a rail lying on a plate face.
- Prompt box not tested:
  - edge/hole hover visuals
  - real clipboard paste
  - touch
  - Firefox/Safari
  - 400 px width
- The recent strip click both inserts and frames. The user hasn't said whether that's wanted.

## Open questions (user)

- Rail and gantry plate sizes are not final. Keep size swapping easy.
- Y axis / pen carriage: 20x20 V-slot with a mini V gantry, or OpenRail? Pen holder and pen lift (probably a servo) are not designed.
- Parts added 2026-11-13: mini V wheel plate, V-slot gantry plate 20 mm, 20x20x500 rail, delrin / mini / xtreme V wheels, mini V actuators, NEMA17 belt-driven actuator, and the OpenBuilds SCRIBE pen lifter (3 printed STL parts, type "other", at print origin; Printables, CC BY-NC-ND 4.0: do not redistribute). The Scribe mounts on the OpenBuilds router mount, which is not in the library.
- Still missing: servo for the pen lift, router mount (or an adapter to the mini V wheel plate).
- SCRIBE facts: it bolts on the OpenBuilds router mount or an ACRO carriage, not on a rail. Footprint 64 x 90 mm (matches the lift base STL). Pens 8-12 mm. Machines without Z use a servo (our case). Its linear guide is 9 mm x 40 mm long (user, from https://makerworld.com/fr/models/1148964-openbuilds-scribe-pen-lifter); not modelled yet. The A1 ACRO Draw Bot is OpenBuilds' plotter built around it.
- Design references: refs_design.md.
- To check later: sag of the cantilevered beam.

## Next steps

1. Y axis: a carriage on the 20x20 beam (mini V wheel plate + delrin mini V wheels, already in the library), a second joint `y`.
2. Pen lift: SCRIBE on the carriage (an adapter or router mount), plus a servo and the 9x40 mm linear guide.
3. `touch` option for mounts/mates (1D: along the slide axis only), only if "until it touches" requests keep coming up. It would replace the hand-computed `end_a_at: -21.65`.
4. Belt clamp hardware on the carriage (clamp points are only marked), motor mount screws, collision check.
5. Later: SEND button + queue file; Mistral benchmark. STEP models have no structure tree.
