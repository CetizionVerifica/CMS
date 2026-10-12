#!/usr/bin/env node
// ADR names (root CLAUDE.md "Working style"): parallel threads picked the same next number more than once, so new
// ADRs carry the owning module: docs/adr/M<n>-NNNN-slug.md, numbered per module. The first ADRs, numbered 0001-0006
// with no prefix, keep their names. Fails on any other name, or on two ADRs with the same module and number.
// It reads the whole folder, so it also catches two PRs that only collide once the merge queue combines them.
//
// Usage: node tooling/scripts/check-adrs.mjs [dir]   (default docs/adr)
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MODULE_ADR = /^(M\d{1,2})-(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const LEGACY_ADR = /^(000[1-6])-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
// Files in docs/adr/ that are not ADRs.
const NOT_ADRS = new Set(['README.md']);

/** The key two ADRs must not share ("M4-0001", or "0003" for an unprefixed one), or null for a bad name. */
export function adrKey(name) {
  const m = MODULE_ADR.exec(name);
  if (m) return `${m[1]}-${m[2]}`;
  const legacy = LEGACY_ADR.exec(name);
  return legacy ? legacy[1] : null;
}

export function adrProblems(names) {
  const problems = [];
  const seen = new Map();
  for (const name of [...names].sort()) {
    if (NOT_ADRS.has(name)) continue;
    const key = adrKey(name);
    if (!key) {
      problems.push(`${name}: name it M<n>-NNNN-slug.md after the module that owns the decision`);
      continue;
    }
    if (seen.has(key)) problems.push(`${name}: ${key} is already used by ${seen.get(key)}`);
    else seen.set(key, name);
  }
  return problems;
}

/** Files an "M<n>: ..." PR adds to docs/adr/ under another module's prefix, or with none. */
export function foreignAdrs(addedFiles, id) {
  return addedFiles.filter(
    (file) =>
      file.startsWith('docs/adr/') &&
      !NOT_ADRS.has(file.slice('docs/adr/'.length)) &&
      !file.startsWith(`docs/adr/${id}-`),
  );
}

function main() {
  const dir = process.argv[2] ?? 'docs/adr';
  const problems = adrProblems(readdirSync(dir).filter((name) => name.endsWith('.md')));
  if (problems.length > 0) {
    console.error(`ADR names in ${dir}:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`ADR names in ${dir} are unique and module-prefixed.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
