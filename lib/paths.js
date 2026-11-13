// Where the private, untracked data lives (CAD downloads, converted models, built library, assemblies, snapshots).
// Default: <repo>/user_data. Override with the USER_DATA environment variable.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.resolve(ROOT, process.env.USER_DATA || 'user_data');
export const INBOX = path.join(DATA, 'inbox');           // raw downloads (zips)
export const PARTS = path.join(DATA, 'parts');           // unpacked STEP / STL sources
export const MODELS = path.join(DATA, 'models');         // converted GLB + catalog.json (tools/convert_all.mjs)
export const LIBRARY = path.join(DATA, 'library');       // deduplicated parts (tools/build_library.mjs)
export const ASSEMBLIES = path.join(DATA, 'assemblies'); // assembly JSON files
export const SNAPS = path.join(DATA, 'snaps');           // tools/snap.mjs output
