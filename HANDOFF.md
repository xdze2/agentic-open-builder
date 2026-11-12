# Handoff: OpenBuilds pen plotter virtual assembly

Last session: 2026-11-13. Read this file, then `VOCABULARY.md` (the shared language for assemblies). `proposal.md` holds the original architecture and STEP sources.

## Goal

Build an assembled 3D model of a pen plotter made from OpenBuilds parts, before buying hardware. Use it to check fit, axis travel and collisions, and to get a bill of materials.

## How we work (user preferences)

- **The viewer is for looking and pointing; it never edits geometry.** The user explicitly does not want to drift into a CAD program. The AI agent edits `assemblies/*.json`, and the viewer live-reloads.
- **Loop:**
  1. In the Build tab, type the request in the prompt box and click pieces in 3D to insert chips.
  2. Press **Copy prompt** and paste into Claude Code.
  3. The agent edits the JSON and checks it with `node tools/solve.mjs <file>`.
  4. The view updates.
  
  The first real test ("move the beam until the mount") worked; the user found it "works well, and simple".
- Agent = Claude Code only, no API. Mistral may come later, which would need a benchmark: plain-text requests + expected `solve.mjs` results.
- Prompt transport is the **clipboard** by choice ("less hacky"). A SEND button writing to a queue file (via a dev-server POST endpoint) was discussed and postponed.
- The user likes big work delegated to subagents to save tokens. Commit only when asked.

## Current design (`assemblies/plotter.json`)

- **Table-top layout.** The actuator lies flat: X rail on the table, gantry plate facing up, motor at the back (+Y). `place.orient {z:+Y, x:+X}` on the plotter root.
- **Actuator** (`assemblies/actuator_2060_500.json`): NEMA17 belt-and-pinion, 20x60x500 rail, 20-80 gantry plate, 4 solid V wheels, motor mount plate, GT2 20T pulley. The motor is the user's **40 mm NEMA17 (`nema17-40`)**. Prismatic joint `x` (40..460 mm).
- **Beam:** 20x20 V-slot, 500 mm (parametric), bolted flat on the gantry plate's free face, sticking out toward the front (-Y) over the paper.
  - Its end butts against the motor mount plate edge: `end_a_at: -21.65` (computed by hand: mount centre y 62.65 - 41).
  - Overhang is 414.85 mm. It is held by 2 M5x11.5 low-profile screws + drop-in tee nuts, in holes `h_10_0` and `h_-49.85_0` (the latter is a 7.1 mm eccentric hole).
- `node tools/solve.mjs assemblies/plotter.json` prints the BOM (42 instances) and the mount details.

## Repository map

```
VOCABULARY.md          world axes, part/face/edge/hole/port names, mount verbs, text -> JSON examples, "how to talk to the agent"
proposal.md            original design proposal (STEP sources, open questions)
parts/                 GrabCAD downloads (gitignored). UNTRUSTED: never run or import anything there
tools/step2glb.mjs     STEP -> GLB (occt-import-js 0.0.23 + @gltf-transform/core 4.5.1); convert_all.mjs = npm run convert
tools/verify.mjs       checks converted GLBs against their catalog
models/<name>/         converted STEP models (gitignored, 10 MB): assembly.glb, catalog.json, parts/*.glb
tools/build_library.mjs  npm run library: models/ -> library/ (34 unique re-centred parts + nema17-40), ports, port validation
library/               tracked, 2 MB: index.json (+ frameRules), <slug>/part.glb + part.json (dims, transform, ports, holes)
lib/mat.js             4x4 rigid transforms (row-major), no deps
lib/vslot_ports.js     V-slot profiles, face / slot / lip ports (node + browser)
lib/assembly.js        solver: parts, mates, mounts (auto screws + tee nuts), sub-assemblies, joints, BOM, edge ports
tools/solve.mjs        CLI: node tools/solve.mjs <file> [--positions] [--state x=120] [--json]
assemblies/*.json      actuator_2060_500.json, plotter.json
viewer/                Vite + three.js: main.js (Assemblies / Parts tabs), buildmode.js (Build tab), prompt.js (prompt box), vslot.js, vite.config.js
```

Run with `npm install` then `npm run dev` (http://localhost:5173), or `npm run build` (-> viewer/dist).

## Viewer

- **Assemblies tab:** the converted STEP models.
- **Parts tab:** library parts with port triads (deep link `#parts/<slug>`). Parametric V-slot 20x20/40/60 with a length field.
- **Build tab:** an assembly file with a slider per joint, BOM, mount summary, click info with copy-ready refs. Live reload on save of `assemblies/*.json` (dev server only). Errors show in the panel.
- **Prompt box** (bottom-left chat input, Build tab):
  - A 3D click inserts a chip at the caret. Pick priority: plate edge < 4 mm, else port/hole < 5 mm, else the instance.
  - Recent strip (last 5, newest left), `@` completion, Copy / Clear.
  - Chips carry the exact JSON ref (`data-ref`). They show a kind icon (part ◼ face ▱ edge ╱ hole ○ port ⊕) and are tinted with the part colour.
  - Hover a chip -> the piece glows. Click a chip -> select + camera fly.
  - Stale refs turn grey after an edit.
  - The draft is kept in localStorage `ob_prompt_draft_v1`.
- The Z-up camera fix: `camera.up` must be set **before** OrbitControls is created.

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
- Missing parts: mini V gantry plate for 20x20, pen holder, servo. Possible GrabCAD sources: "Mini V Gantry Set".
- To check later: sag of the cantilevered beam.

## Next steps

1. Add the `touch` option to mounts/mates. Use it to replace the hand-computed `end_a_at: -21.65`.
2. Y axis: a carriage running on the beam (mini V gantry + wheels), a second joint `y`, a pen holder.
3. Belts (parametric GT2), motor mount screws, collision check.
4. Later: SEND button + queue file; Mistral benchmark.
