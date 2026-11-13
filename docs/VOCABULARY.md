# Vocabulary: how we name things

One shared language for the human, the viewer and an AI agent. The assembly is a JSON file in `user_data/assemblies/`; the solver is `lib/assembly.js`; `node tools/solve.mjs user_data/assemblies/<file>.json` prints the BOM and any error (the error lists the valid names). Units: mm and degrees.

## 1. World

Right-handed, **Z up**, seen from the front (the viewer's default camera looks from the front, right and above).

| Word | Direction | Axis |
|---|---|---|
| `right` / `left` | along the X axis travel | +X / -X |
| `back` / `front` | away from / towards the viewer | +Y / -Y |
| `up` / `down` | | +Z / -Z |

- **X = the X-axis travel direction** (the long rail). **Y = front/back**. **Z = up/down**.
- **Origin**: the centre of `end_a` of the root rail, on its centre line. The X rail therefore occupies x = 0..500, y = -10..10, z = -30..30 (20x60 profile standing on its 60 mm side, 20 mm deep).
- In the standard pose the gantry plate's free face looks to the **front** (-Y); the rail is behind it; the motor is **up** (+Z) and in front.
- `state.x` = position of the gantry along the rail, **mm from `end_a`** to the plate centre.

## 2. Instances and part types

Every piece in `parts` has a human name (`rail`, `plate`, `beam`, `w1_wheel` ...). Letters, digits and `_` only (no `. / : @`). Names inside a sub-assembly are addressed `subname/instance` (`actuator/plate`). Mount-generated pieces are `<mount name>/screw_1`, `<mount name>/nut_1`.

A part entry is one of:
- `{"part": "<library slug>"}`, for instance `v-slot-gantry-plate-20-80mm`, `nema17-40`, `tee-nut`. The list is in `user_data/library/index.json` (viewer: Parts tab).
- `{"part": "vslot-20x20", "length": 500}`: a parametric V-slot cut to length (`vslot-20x20`, `vslot-20x40`, `vslot-20x60`). It shows up in the BOM as a cut length.
- `{"assembly": "actuator_2060_500.json"}`: a sub-assembly (a file in `user_data/assemblies/`); it moves as one rigid group.

**Groups (structure tree only).** Any part, mount or belt can carry `"group": "Y axis/carriage/wheel 1"` (`/` nests folders). Groups are sorted by function (X axis, Y axis, then carriage / drive / wheel N ...). They only set the folders of the viewer's Structure tree: refs, mates and the BOM ignore them, so you can move a piece to another group without breaking anything. A sub-assembly's pieces sit under `<its group>/<sub-assembly name>/<group inside the sub-assembly file>`. A mount's generated screws and nuts go in a collapsed "Fasteners" folder inside the mount's group. Give every new piece a group.

Types: `rail`, `plate`, `wheel`, `motor`, `pulley`, `screw`, `nut`, `tee_nut`, `spacer`, `shim`, `bearing`, `block`, `belt` (parametric source part from `lib/belt.js`, routed by `belts`).

## 3. Ports, faces, positions

A **port** is a frame on a part: an origin, a `z` axis pointing OUT of the face, and an `x` reference axis. Reference it as `"instance.port"`. A mate puts port A face to face on port B (the two `z` axes end up opposite).

### Rails (V-slot)
Profile frame: length along local Z from `end_a` (z=0) to `end_b` (z=length). Faces are named by the profile axes (not by the world), so they stay the same wherever the rail is placed:

| Face | Local normal | Notes |
|---|---|---|
| `top` / `bottom` | +Y / -Y | for 20x60 these are the wide (60 mm) faces, 3 slots each |
| `right` / `left` | +X / -X | the narrow faces (20 mm), 1 slot each |
| `end_a` / `end_b` | -Z / +Z | the cut ends |

In the actuator pose (`place.orient z=+X, x=+Z`) `top` is the **front** face, `bottom` the back, `right` the upper face (+Z), `left` the lower face (-Z).

- `<face>` = centre of the face at `end_a`. `<face>_slot_<i>` = centre line of the i-th slot (numbered by increasing local X for top/bottom, local Y for left/right; for 20x60 top: slot 1 = x -20, slot 2 = centre, slot 3 = x +20). `<face>_slot_<i>_lip` = underside of the slot lip (1.8 mm deep, `z` pointing into the profile), where a tee nut lies.
- **Position along a rail = mm from `end_a`**. All face and slot ports have their `x` along the rail, so a mate `offset: [d, 0, 0]` slides d mm along it. Shortcut in a port name: `beam.bottom_slot_1@120` = the slot line at 120 mm from `end_a`. Library rails and the parametric ones expose the same ports (`lib/vslot_ports.js`).
- `mid` = rail centre.

### Plates (gantry plate, motor mount plate, ...)
Plate-local frame: origin at the plate centre, **x** along the longest side (127 mm on the 20-80 gantry plate), y along the other, z through the thickness.
- `front` = the **free face** (the one facing the viewer in the standard pose; carries the motor mount and, for the plotter, the beam). `back` = the wheel / rail side. (In the library files `front` is the z=0 face, which the older port names `center_back`, `wheel_N`, `center` call "back/front" the other way round: use `front`/`back` below, they are the reference.)
- Other ports: gantry plate `wheel_1..4` (= `back:` holes), `motor_mount`; motor mount plate `to_gantry`, `motor`.
- **Holes**: every circular hole is recorded in `part.json` with its diameter. Name = plate-local coordinates: `h_<x>_<y>` (mm, e.g. `h_-19.85_0`). The four wheel holes also answer to `wheel_1` (+x,+y), `wheel_2` (-x,+y), `wheel_3` (-x,-y), `wheel_4` (+x,-y).
  - `front:h_-19.85_0` / `back:h_-19.85_0` = the hole on that face (face first, then hole).
  - `front@-20,0.5` = nearest hole to plate-local coordinates (snaps within 2 mm; otherwise a free point on the face).
  - Diameters on the 20-80 gantry plate: 5.1 mm (M5 clearance) on a ~10 mm grid, 7.1 mm eccentric-spacer holes at x = -19.85 .. -49.85 (rows y = 0, +-30.32), and larger openings (8.57, 23.29) which fasteners ignore.

- **Edges**: every plate also has four edge ports on the side faces of its bounding rectangle (plate-local, computed in `lib/assembly.js` `edgePorts`, resolved by `findPort` like any port): `edge_+x`, `edge_-x`, `edge_+y`, `edge_-y`. Origin = midpoint of the side face (mid thickness), `z` = outward normal (so a mate puts a part face to face on the edge), `x` = direction along the edge (+y for the x edges, +x for the y edges). `edge_+y@10` slides 10 mm along it. Note `+x/+y` are PLATE-local: on the gantry plate in the standard pose plate +y points along world +X (the copied prompt also gives the world midpoint, direction and outward normal). Rails have no long-edge ports yet (only `end_a`/`end_b` and the face/slot ports).

### Motor (nema17-40)
`face` = mounting face (z toward the shaft), `shaft` = shaft tip, `hole_1..4` = M3 holes (31 mm pitch). Body 40 mm (`bbox z -40 .. 24`).

### Small parts
- Axial parts (spacer, shim, bearing, nut, pulley): `end_a` (-Z end face), `end_b` (+Z end face), `center`. The eccentric spacer also has `bore_a`/`bore_b` on the off-centre bore (0.79 mm).
- Screws: `under_head` (z toward the tip, mates on the face the head rests on), `head_top`, `tip`. Head is 1.5 mm high.
- Tee nut: `face_a` (toward the slot opening, mates on `<face>_slot_<i>_lip`), `face_b`, `center`.
- Wheel: `center`, `axle_front`, `axle_back`.

## 4. Verbs

### `mates`: low level, port on port
```json
{ "name": "...", "a": "inst.port", "b": "inst.port", "rotate": 0, "offset": [0,0,0], "joint": {...} }
```
- `a` is placed face to face on `b` (the one already placed moves nothing; the other is solved). Solving runs outward from `root` (default: first part); an unreachable instance is an error.
- `rotate`: degrees about the shared Z (B's z axis). `offset`: [x, y, z] in B's port frame (z = away from B's face).
- `joint`: `{"type": "prismatic", "axis": "x|y|z", "state": "<variable>", "range": [min, max], "label": "..."}` adds `state[<variable>]` along that axis of B's frame. The viewer makes one slider per joint.
- Root placement: `"place": {"orient": {"z": "+X", "x": "+Z"}, "pos": [0,0,0]}` maps the part's local z and x onto world axes.

### `mounts`: high level, a rail lying on a plate and bolted to it
```json
{ "name": "beam_on_plate", "rail": "beam", "rail_face": "bottom", "slot": 1,
  "plate": "actuator/plate", "plate_face": "front",
  "direction": "down", "line": 0, "overhang": 440,
  "fasten": { "with": "low-profile-screw-m5", "nut": "tee-nut", "count": 2 } }
```
| Key | Meaning | Default |
|---|---|---|
| `rail` | instance name of the rail (a single part, must not be placed by anything else) | required |
| `rail_face`, `slot` | the rail face lying on the plate and its slot (the slot line is what the screws follow) | required, centre slot |
| `plate`, `plate_face` | plate instance and `front` (free face) or `back` | required, `front` |
| `direction` | the way the rail runs from `end_a` to `end_b`: a world word (`up down left right front back`) lying in the plate plane, or plate-local `+x -x +y -y` | required |
| `line` | plate-local coordinate of the slot line, across the direction: y when running along x, x when running along y | 0 |
| `overhang` | mm of rail hanging beyond the plate edge in `direction` (so `length - overhang` lies on the plate) | 0 |
| `end_a_at` | instead of `overhang`: plate-local coordinate of `end_a` along `direction`, measured from the plate centre | |
| `offset` | extra [x,y,z] in the plate face frame (z = gap above the face) | [0,0,0] |
| `fasten.with` | screw family prefix (library slug prefix); the length is chosen automatically | `low-profile-screw-m5` |
| `fasten.nut` | tee nut part | `tee-nut` |
| `fasten.count` | number of screws | 2 |
| `fasten.margin` | keep this far from the rail ends (mm) | 8 |
| `fasten.min_protrusion` | thread beyond the nut (mm) | 0.8 |
| `fasten.holes` | explicit hole list instead of the automatic search | |
| `fasten.tolerance`, `hole_diameter` | slot line tolerance (0.6 mm), accepted diameters ([4.8, 7.4]) | |

What a mount does: puts the rail face on the plate face (with `direction`, `line`, `overhang`); finds the plate holes whose centres lie within `tolerance` of the slot line, inside the rail span (minus `margin`), and spreads `count` of them over it; puts a tee nut in the slot under each hole (at the right distance from `end_a`) and a screw through the hole from the OTHER face of the plate; picks the shortest listed screw whose shank exceeds plate + gap + lip (1.8) + nut thickness by `min_protrusion`. It fails with a message listing the plate lines that do have holes under the rail when nothing lines up.

### `belts`: a timing belt routed around pulleys
```json
"belts": [{ "name": "y_belt", "part": "gt2-belt-6mm",
            "from": "carriage.edge_+y", "around": ["y_idler", "y_pulley"], "to": "carriage.edge_-y" }]
```
| Key | Meaning | Default |
|---|---|---|
| `name` | instance name of the belt (shows in the BOM and the tree) | required |
| `part` | belt source part from the catalogue in `lib/belt.js`: `gt2-belt-6mm`, `gt2-belt-9mm`, `gt3-belt-9mm` (profile, pitch, width, thickness, material; sold by length) | `gt2-belt-6mm` |
| `around` | pulley instances (at least 2). An entry is a name, or `{"pulley", "radius", "offset", "port"}` | required |
| `from`, `to` | clamp ports of an **open** belt (both or neither). The belt is cut where the loop passes nearest to each port and runs from `from` round every pulley to `to` (the two clamps must sit on the same span). Without them: an endless loop | |

A belt is solved after every mate and mount, so it follows a moving carriage. It wraps the outside of every pulley (convex loop) in the plane perpendicular to the first pulley's axis. The BOM row is `<part> x <length>`: the **cut length** clamp to clamp for an open belt (no allowance for the clamps themselves), the loop length for an endless one. Per pulley, `radius` is the belt centre-line radius and `offset` the belt plane along the pulley axis from its `center` port. Defaults (`lib/belt.js` `beltSeat`): GT2/GT3 timing pulleys use the pitch radius (teeth x pitch / 2 pi) and offset -2.5 (teeth at local z -6..+1, hub with grub screws toward +Z); the smooth idler pulley uses running surface 17.5 mm + half a belt and offset 0. Any other part needs an explicit `radius`. Pulleys more than 0.5 mm off the belt plane, or a clamp port more than 20 mm from the belt, give a warning. The belt is drawn as a flat band without teeth; clamp points are red spheres. In the Parts tab the belts have cards (`lib:gt2-belt-6mm` chips); `{"part": "gt2-belt-6mm", "length": 300}` in `parts` is a straight loose piece.

## 5. Plain text to JSON

1. "Put a 500 mm 20x20 beam flat on the gantry plate front face, pointing down, 440 mm hanging out, two M5 screws."
   `"beam": {"part": "vslot-20x20", "length": 500}` + the mount above.
2. "Same, but the beam runs to the right (parallel to the rail) along the column of holes at plate-local x = -19.85."
   `"direction": "right", "line": -19.85` (plate-local `y` runs along world +X in the standard pose; for a beam along plate y, `line` is a plate-local x). The mount reports the two holes it found, `h_-19.85_0` and `h_-19.85_30.32`.
3. "Move the gantry to 120 mm from the left end."
   `"state": {"x": 120}`.
4. "Fix the beam to the plate at the two plate holes at the plate-local points (-20, 0) and (-50, 0)."
   `"fasten": {"count": 2, "holes": ["front@-20,0", "front@-50,0"]}` (the screw still enters from the far face).
5. "Put a motor on the gantry mount plate." (low level mate)
   `{"a": "motor.face", "b": "mount.motor"}`; "a pulley 9 mm above the motor face": `{"a": "pulley.end_a", "b": "motor.face", "offset": [0,0,9]}`.
6. "The belt starts at the carriage front edge, goes round the tension pulley, then the motor, and back to the carriage."
   `"belts": [{"name": "y_belt", "part": "gt2-belt-6mm", "from": "carriage.edge_+y", "around": ["y_idler", "y_pulley"], "to": "carriage.edge_-y"}]`; `node tools/solve.mjs` prints the cut length, the clamps and the wrap angle on each pulley.

## 6. How to talk to the agent (click -> chip -> copy -> paste)

The viewer never edits geometry. The Build tab has a prompt box to write a request that mixes text with exact references:
1. Type in the box (or click in it). Click a part, hole, port or plate edge in 3D: a **chip** is inserted at the caret (label such as `plate › edge +y`; the exact reference such as `actuator/plate.edge_+y` is stored in the chip, hover to see it). A click within 4 mm of a plate edge selects the edge; within 5 mm of a port or hole selects that; otherwise the whole instance. If the box is not the last thing you focused, the click only fills the **recent strip** (last 5 selections, click one to insert it at the caret).
2. Typing `@` opens a list of instances (Tab/Enter/click inserts a chip; type `name.` to list that instance's ports and edges).
3. The camera button under the box **freezes the view** and opens a drawing toolbox (viewer/sketch.js, an SVG layer); the prompt box stays usable above it. Tools (the line under the bar says what the active one does):
   - **Select** (V): click a mark to select it, drag it, reshape it by its handles; Del removes it, a colour recolours it, double-click edits a text.
   - **Point at** (N): click = a numbered pin on what is under it; drag = from the thing to a numbered label (a callout). For "this one", "here".
   - **Move arrow** (M): drag from what should move to where it should go. Described as a movement, with a displacement in mm.
   - **Box** (B), **Freehand** (P), **Text** (T). 4 colours, undo (Ctrl+Z), erase all.

   Every mark but text has a number, stable while drawing (a deleted number is not reused). **Click a number badge** (or "→ prompt" on the selected mark) to insert a chip for that mark at the caret, e.g. `move 2`; it resolves to "mark 2 on image N" (it turns stale if the drawing is cancelled or the image deleted). Marks are anchored in 3D when drawn or moved: pointer / arrow ends / text → the part, port or edge chip under them and the world point; box → the parts inside it; freehand → the parts it crosses. A point on no part gets a guessed depth (the plane facing the camera through the other end of the arrow, or through the orbit target) and is flagged as such. **Capture** (Enter) flattens the drawing onto the frozen frame and adds it as a **screenshot** (uploaded at once to `user_data/prompts/_draft/`); **Cancel** (Esc) goes back. Thumbnails are numbered; hover to enlarge, click to put the camera back where it was taken, ✕ to delete.
4. **Send** (dev server only) writes `user_data/prompts/<stamp>/`: `prompt.md` (assembly file, current `state`, the request with chips written as `«label»`, a References list with the exact refs and world positions/normals, and per screenshot: path, view direction, centre, mm per pixel, then one line per mark with its number, colour, kind, anchors, displacement for move arrows, and image px), `prompt.json` (the same as data, with each image's camera), and `1.png`, `2.png`… It copies `Read user_data/prompts/<stamp>/prompt.md` to the clipboard; paste it into Claude Code, which then reads the images with the Read tool. **Copy text** copies the text block alone (no screenshots). The box keeps its content and screenshots (the draft survives reloads in localStorage); **Clear** empties both.
5. The agent edits `user_data/assemblies/*.json`; the viewer live-reloads (dev server).
