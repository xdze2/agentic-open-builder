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
];
let fail = 0;
for (const [f, out] of jobs) {
  console.log(`\n== ${out}`);
  const r = spawnSync(process.execPath, ['tools/step2glb.mjs', A + f, 'models/' + out], { stdio: 'inherit' });
  if (r.status) fail++;
}
process.exit(fail ? 1 : 0);
