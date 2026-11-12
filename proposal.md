# OpenBuilds Pen Plotter: Virtual Assembly Proposal

Goal: build an assembled 3D model of a pen plotter made from OpenBuilds modules, before buying hardware, so the design can be checked (fit, travel, collisions) and a bill of materials produced.

Target design:
- X axis: V-slot 20x60 rail, 4-wheel horizontal gantry carriage
- Y axis: V-slot 20x20 rail mounted on the X carriage, 4-wheel vertical carriage holding the pen
- NEMA17 motors, GT2 belts

The system has three layers: **parts** (geometry + ports), **assembly** (JSON describing instances and mates), and a **viewer** (three.js).

---

## 1. Parts: parametric, generated in code

OpenBuilds STEP/STL models exist (OpenBuilds part store, GrabCAD), but they are heavy, carry no connector information, and need converting for three.js. The part list here is short and the shapes are simple, so parts are written as **parametric JS functions**: each returns three.js geometry plus a list of named ports.

| Part | Parameters | Example ports |
|---|---|---|
| V-slot 20x60, 20x20 | `length` | `end_a`, `end_b`, `slot_top_1(t)`, rail station along length |
| Gantry plate (wide for 20x60, mini for 20x20) | — | `wheel_1..4`, `center`, `motor_mount` |
| V-wheel + eccentric spacer | — | `axle` |
| NEMA17 | `body_length` | `face`, `shaft` |
| GT2 pulley 20T / idler | — | `bore`, `belt_plane` |
| Belt | computed from pulley positions | — |
| Pen holder | — | `mount`, `pen_tip` |

- The V-slot profile is a real cross-section (`THREE.Shape` extruded to length).
- Critical dimensions (slot width, gantry plate wheel hole spacing, eccentric spacer offset) **must be verified against OpenBuilds' published drawings**: they decide whether wheels actually grip the rail.
- Escape hatch: any part's geometry can be replaced by a GLB converted from a real STEP file, keeping the same port definitions.

## 2. Ports and assembly JSON

A **port** is a coordinate frame attached to a part: origin, Z axis pointing out of the mating face, X axis as reference orientation (same idea as Onshape mate connectors).

A **mate** places port A onto port B face to face (Z axes opposite, origins coincident), with an optional rotation about Z and an optional offset.

```json
{
  "parts": {
    "x_rail":     { "type": "vslot", "profile": "20x60", "length": 600 },
    "x_carriage": { "type": "gantry_plate", "variant": "wide" },
    "y_rail":     { "type": "vslot", "profile": "20x20", "length": 300 },
    "y_carriage": { "type": "gantry_plate", "variant": "mini" },
    "motor_x":    { "type": "nema17", "body_length": 40 }
  },
  "root": "x_rail",
  "mates": [
    { "a": "x_rail.rail_front", "b": "x_carriage.center",
      "joint": { "type": "prismatic", "axis": "x", "var": "X", "range": [0, 500] } },
    { "a": "x_carriage.top_center", "b": "y_rail.side_mid", "rotate": 90 },
    { "a": "y_rail.rail_front", "b": "y_carriage.center",
      "joint": { "type": "prismatic", "var": "Y", "range": [0, 220] } },
    { "a": "x_carriage.motor_mount", "b": "motor_x.face" }
  ],
  "state": { "X": 120, "Y": 80 }
}
```

- Mates form a **tree** rooted at `root`; the solver walks it and composes frame transforms. No constraint solver needed.
- `joint` turns a fixed mate into a moving axis, driven by `state` variables. Moving the axes shows real travel and collisions.
- Sub-assemblies (e.g. a gantry plate already knows where its 4 wheels go) keep the top-level JSON small.
- The same data produces a **bill of materials**, including extrusion cut lengths.

## 3. Viewer (three.js)

Vite + three.js, no backend.

- Load assembly JSON → build parts → solve transforms → render
- OrbitControls, click-to-highlight a part
- Toggle to display port frames as small axis gizmos (essential for debugging mates)
- One slider per joint variable
- Optional: live reload when the JSON is edited

## 4. Roadmap

1. V-slot part with ports + solver + viewer with port gizmos (proves the architecture)
2. 20x60 rail + wide gantry plate + wheels + X slider
3. 20x20 Y axis on the X carriage + pen holder
4. NEMA17s, pulleys, computed belt paths, BOM

## 5. Design points to watch

- The Y rail is cantilevered on the X carriage: check sag/stiffness at the far end.
- Pen lift mechanism (typically a servo) is not specified yet.

## 6. Open question

Parts in pure JS (browser only, chosen to start), or in Python/CadQuery (could also export STEP for 3D-printing custom brackets later)?
