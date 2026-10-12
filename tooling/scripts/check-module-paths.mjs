#!/usr/bin/env node
// Path guard (root CLAUDE.md "Parallel module rules"): a PR titled "M<n>: ..." may only change
// the paths module M<n> owns in tooling/modules.json, and may only add ADRs named docs/adr/M<n>-NNNN-slug.md.
// PRs without a module prefix are not checked.
//
// Usage: node tooling/scripts/check-module-paths.mjs "<PR title>" <base-ref>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { foreignAdrs } from './check-adrs.mjs';

export function moduleFromTitle(title) {
  const match = /^\s*\[?(M\d{1,2})\b/i.exec(title ?? '');
  return match ? match[1].toUpperCase() : null;
}

export function outOfScope(files, owned, shared) {
  const allowed = [...owned, ...shared];
  return files.filter(
    (file) => !allowed.some((prefix) => file === prefix || file.startsWith(prefix)),
  );
}

function main() {
  const [title, baseRef] = process.argv.slice(2);
  const config = JSON.parse(readFileSync(new URL('../modules.json', import.meta.url), 'utf8'));
  const id = moduleFromTitle(title);
  if (!id) {
    console.log('PR title has no module prefix (e.g. "M4: ..."); path guard skipped.');
    return;
  }
  const owned = config.modules[id];
  if (!owned) {
    console.error(`Unknown module ${id}. Known: ${Object.keys(config.modules).join(', ')}.`);
    process.exit(1);
  }
  const files = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const bad = outOfScope(files, owned, config.shared);
  if (bad.length > 0) {
    console.error(`${id} may only change: ${[...owned, ...config.shared].join(', ')}`);
    console.error(`These files belong to another module:\n  ${bad.join('\n  ')}`);
    console.error('Ask the owning module (via the coordinator) to make that change instead.');
    process.exit(1);
  }
  const added = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=A', `${baseRef}...HEAD`],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(Boolean);
  const foreign = foreignAdrs(added, id);
  if (foreign.length > 0) {
    console.error(
      `${id} may only add ADRs named docs/adr/${id}-NNNN-slug.md:\n  ${foreign.join('\n  ')}`,
    );
    process.exit(1);
  }
  console.log(`${id}: all ${files.length} changed files are inside the module's paths.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
