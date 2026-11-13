# Agentic Open Builder

A virtual assembly of a table-top pen plotter made from OpenBuilds parts, built before buying the hardware. It is used to check fit, axis travel and collisions, and to get a bill of materials.

Assemblies are JSON files (`user_data/assemblies/*.json`) edited by an AI agent (Claude Code) and checked by a solver. The browser viewer is for looking and pointing only; it never edits geometry. See [docs/HANDOFF.md](docs/HANDOFF.md) for the details and [docs/VOCABULARY.md](docs/VOCABULARY.md) for the assembly language.

![Viewer with the plotter assembly](docs/screenshots/viewer-plotter.png)

## Example

A real prompt: *Add a belt tensioner in* «box 1» *, using* «Idler Pulley Plate» *plate*. The view is frozen, a box is drawn at the free end of the beam and its badge clicked to put «box 1» in the prompt; the plate comes from the **+** on its library card:

![The viewer while drawing: box 1 at the free end of the beam, and the prompt with its two chips](docs/screenshots/example-prompt.png)

**Send** writes `user_data/prompts/2026-11-13_102625/` with `1.png`, `prompt.json` and this `prompt.md`, which the agent reads:

```text
[plotter viewer] assembly: user_data/assemblies/plotter.json   state: {"x":250,"y":250}
Request: Add a belt tensioner in «box 1» , using «Idler Pulley Plate» plate
References:
- «box 1» = img:mwerujqniphg#1  mark 1 on image 1 (red box, described under Screenshots)
- «Idler Pulley Plate» = lib:idler-pulley-plate  library part idler-pulley-plate (user_data/library/idler-pulley-plate/part.json), type plate, 67 × 39.5 × 3 mm
(lib:<slug> = a library part, used in the assembly JSON as {"part": "<slug>"}; lib:vslot-<profile> = a parametric V-Slot rail)
Screenshots (open each one with the Read tool; orthographic views, so the scale is the same everywhere in an image):
- user_data/prompts/2026-11-13_102625/1.png — 1029×886 px, assembly: user_data/assemblies/plotter.json; looking from iso [0.57, -0.68, 0.46] at [250.0, -187.3, 24.0] mm (image centre), 0.794 mm per px
  Marks drawn on it (3D points in mm, world frame):
    1. red box around «beam»; centre on «beam» at [241.8, -478.4, 35]; image px (211, 501)–(333, 611)
Read docs/VOCABULARY.md, edit the assembly JSON, run `node tools/solve.mjs <file>` to check it.
```

The chips become named references, and the drawn box is turned into 3D points (it is around `beam`, centre at [241.8, -478.4, 35] mm), so the agent knows where to work without guessing from pixels.

## How it fits together

![Front app (3D view, parts, prompt), local backend (JSON and CAD files) and the Claude agent](docs/workflow.excalidraw.svg)

## Quick start

```sh
npm install
npm run dev            # viewer at http://localhost:5173
node tools/solve.mjs user_data/assemblies/plotter.json                     # solve, BOM, mounts
node tools/snap.mjs user_data/assemblies/plotter.json --view iso,top,front # PNG snapshots in user_data/snaps/
```

Other commands:

| Command | What it does |
|---|---|
| `npm run convert` | STEP / STL files in `user_data/parts/` → GLB models in `user_data/models/` |
| `npm run library` | `user_data/models/` → deduplicated library parts with ports in `user_data/library/` |
| `npm run thumbs` | thumbnails for parts, assemblies and models (`--force` to redo all) |
| `npm run build` | static viewer in `viewer/dist` |
| `node tools/readme_shots.mjs` | retake the viewer screenshots in `docs/screenshots/` by driving the UI |

## Private data: `user_data/`

Everything derived from downloaded CAD files, plus your own assemblies, lives in `user_data/`, which git ignores as a whole (set `USER_DATA=<dir>` to put it elsewhere):

```
user_data/
  inbox/        raw downloads (zips)
  parts/        unpacked STEP / STL
  models/       converted GLB + catalog.json
  library/      built parts (part.glb, part.json, thumb.png) + index.json
  assemblies/   assembly JSON files
  snaps/        snapshot output
```

A fresh clone has an empty viewer: put the CAD files in `user_data/parts/`, then run `npm run convert`, `npm run library`, `npm run thumbs`.

## Viewer

- **Left:** a browser with Parts, Assemblies and STEP models tabs, with search, thumbnails and collapsible groups.
- **Centre:** an orthographic 3D view with shadows and a scale bar. A toolbar at the top right holds zoom/fit, Iso/Top/Front/Right and a **View** dropdown (axes, grid, shadows, edge lines, port markers; remembered in localStorage).
- **Right:** the assembly and part info. **Structure** tree (assembly > sub-assemblies > instances, with hide/isolate, filter and insert-in-prompt; synced with 3D clicks and hover), selection info with copy-ready references, joint sliders and mounts.
- **Bottom:** a prompt box. Click parts, faces, edges or holes in 3D to insert them as chips, add screenshots, then send the prompt to Claude Code.

| Plotter (snapshot tool) | Bill of materials |
|---|---|
| ![Plotter iso snapshot](docs/screenshots/plotter-iso.png) | ![BOM dialog](docs/screenshots/viewer-bom.png) |

| Parametric rail with standard lengths | Real V-slot 20x20 profile |
|---|---|
| ![Rail profile view](docs/screenshots/viewer-rail.png) | ![V-slot 20x20 end view](docs/screenshots/vslot-20x20-profile.png) |

## Agent loop

1. In the viewer, type a request and click the pieces it refers to.
2. Optionally add screenshots of the view (camera button under the box). The view freezes so you can draw on it: pins, arrows, boxes, freehand and text, each numbered so the prompt can refer to it.
3. Press **Send**: the prompt and screenshots are saved to `user_data/prompts/<date>/` and a `Read …/prompt.md` line is copied. Paste it into Claude Code. (**Copy text** copies the prompt as plain text without screenshots, and works without the dev server.)
4. The agent edits the assembly JSON, checks it with `tools/solve.mjs` and looks at `tools/snap.mjs` snapshots.
5. The viewer reloads live.

## Sources and licenses

Part models are GrabCAD / Printables downloads. They and everything derived from them (models, library) stay in the untracked `user_data/` and are not redistributed. The OpenBuilds SCRIBE pen lifter (Printables) is licensed CC BY-NC-ND 4.0.

## License

MIT, see [LICENSE](LICENSE). Part models from OpenBuilds are not included in this repository (they live in the ignored `user_data/`) and stay under their own license.
