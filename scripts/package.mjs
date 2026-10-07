// Copies only the files Chrome needs into dist/ (load this folder, or the project root, as unpacked).
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
for (const entry of ['manifest.json', 'src', 'icons']) {
  cpSync(join(root, entry), join(dist, entry), { recursive: true });
}
console.log('package: wrote dist/ (manifest.json, src/, icons/)');
