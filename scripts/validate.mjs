// Static checks for the unpacked extension: manifest shape, every referenced file exists,
// every JS file parses, and every <script>/<link>/<img> in the HTML pages resolves.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const fail = (m) => errors.push(m);
const must = (rel, why) => {
  if (!existsSync(join(root, rel))) fail(`${why}: missing file ${rel}`);
};

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
if (!manifest.name || !manifest.version) fail('manifest needs name and version');
must(manifest.background?.service_worker, 'background.service_worker');
for (const cs of manifest.content_scripts || []) for (const js of cs.js || []) must(js, 'content_scripts');
must(manifest.action?.default_popup, 'action.default_popup');
must(manifest.options_ui?.page, 'options_ui.page');
for (const p of Object.values(manifest.icons || {})) must(p, 'icons');
for (const p of Object.values(manifest.action?.default_icon || {})) must(p, 'action.default_icon');

// HTML references
for (const page of [manifest.action?.default_popup, manifest.options_ui?.page].filter(Boolean)) {
  const html = readFileSync(join(root, page), 'utf8');
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    const target = relative(root, resolve(join(root, dirname(page)), ref));
    must(target, `${page} reference`);
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(html)) fail(`${page}: inline <script> is blocked by MV3 CSP`);
}

// Syntax-check every JS file
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
for (const file of walk(join(root, 'src')).filter((f) => f.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    fail(`syntax error in ${relative(root, file)}:\n${e.stderr}`);
  }
}

if (errors.length) {
  console.error(`validate: ${errors.length} problem(s)\n - ${errors.join('\n - ')}`);
  process.exit(1);
}
console.log('validate: manifest, file references and JS syntax OK');
