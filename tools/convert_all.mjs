// Converts all known inputs. Usage: node tools/convert_all.mjs
import { spawnSync } from 'node:child_process';
const A = 'parts/';
const jobs = [
  ['nema-17-stepper-motor-21.snapshot.1/Nema 17 Stepper Motor.step', 'nema17'],
  ['v-slot-belt-and-pinion-actuator-500mm-1.snapshot.1/V Slot Belt and Pinion Actuator 500mm.stp', 'actuator_2060_500'],
  ['nema-23-v-slot-belt-driven-actuator-500mm-1.snapshot.1/Nema 23 V Slot Belt Driven Actuator 500mm.stp', 'actuator_nema23_2060_500'],
  ['micro-limit-switch-plate-3.snapshot.1/Micro Limit Switch Plate.step', 'limit_switch_plate'],
  ['motor-mount-plate-nema-17-1.snapshot.1/Motor Mount Plate Nema 17.step', 'motor_mount_nema17'],
  ['v-slot-20x60x1000-1.snapshot.1/V-Slot 20x60x1000 Linear Rail.step', 'vslot_2060_1000'],
  ['open-rail-gantry-plate-40mm-1.snapshot.1/Open Rail Gantry Plate 40mm.step', 'openrail_plate_40'],
  ['v-slot-gantry-plate-20-80mm-1.snapshot.1/V-Slot Gantry Plate 20-80mm.step', 'gantry_plate_20_80'],
  ['openrail-gantry-kit-1.snapshot.2/OpenRail Gantry Kits.step', 'openrail_gantry_kit'],
  ['delrin-v-wheel-1.snapshot.1/Delrin V Wheel.step', 'delrin_v_wheel'],
  ['mini-v-linear-actuator-500mm-1.snapshot.1/Mini V Linear Actuator 500mm.stp', 'mini_v_linear_actuator_500'],
  ['mini-v-slot-belt-and-pinion-actuator-500mm-1.snapshot.1/Mini V Slot Belt and Pinion Actuator 500mm.stp', 'mini_v_belt_pinion_actuator_500'],
  ['mini-v-wheel-plate-1.snapshot.1/Mini V Wheel Plate.step', 'mini_v_wheel_plate'],
  ['nema-17-v-slot-belt-driven-actuator-500mm-1.snapshot.1/Nema 17 V Slot Belt Driven Actuator 500mm.stp', 'actuator_nema17_belt_driven_500'],
  ['solid-v-wheel-assembly-1.snapshot.1/Solid V Wheel assy.stp', 'solid_v_wheel_assy'],
  ['v-slot-20x20x500-1.snapshot.1/V-Slot 20x20x500 Linear Rail.step', 'vslot_2020_500'],
  ['v-slot-gantry-plate-20mm-1.snapshot.1/V-Slot Gantry Plate 20mm.step', 'gantry_plate_20'],
  ['xtreme-solid-v-wheel-1.snapshot.1/Xtreme Solid V Wheel.step', 'xtreme_solid_v_wheel'],
  // Printables, CC BY-NC-ND 4.0 (OpenBuilds): STL, one solid per file, at print origin
  [['lift-base', 'lift', 'preloader'].map((n) => `openbuilds-scribe-pen-lifter/openbuilds-scribe-${n}.stl`), 'scribe_pen_lifter'],
];
let fail = 0;
for (const [f, out] of jobs) {
  console.log(`\n== ${out}`);
  const r = spawnSync(process.execPath, ['tools/step2glb.mjs', ...[f].flat().map((x) => A + x), 'models/' + out], { stdio: 'inherit' });
  if (r.status) fail++;
}
process.exit(fail ? 1 : 0);
