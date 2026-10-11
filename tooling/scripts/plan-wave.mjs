#!/usr/bin/env node
// Which modules can start now without stepping on each other (root CLAUDE.md "Parallel module rules").
// A module is startable when every module it needs (tooling/modules.json "needs") is merged, it is not merged or
// running already, and its paths overlap neither a running module nor another module picked in the same wave.
//
// Usage: node tooling/scripts/plan-wave.mjs --merged M1 --running M0,M2
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export function pathsOverlap(a, b) {
  return a.some((x) => b.some((y) => x === y || x.startsWith(y) || y.startsWith(x)));
}

// Every module `id` needs directly or through the modules it needs.
export function allNeeds(id, needs, seen = new Set()) {
  for (const dep of needs[id] ?? []) {
    if (!seen.has(dep)) {
      seen.add(dep);
      allNeeds(dep, needs, seen);
    }
  }
  return seen;
}

// Pairs of modules that could be in flight at the same time (neither needs the other) yet own overlapping paths.
export function concurrentOverlaps(modules, needs) {
  const ids = Object.keys(modules);
  const bad = [];
  for (const [i, a] of ids.entries()) {
    for (const b of ids.slice(i + 1)) {
      const ordered = allNeeds(a, needs).has(b) || allNeeds(b, needs).has(a);
      if (!ordered && pathsOverlap(modules[a], modules[b])) bad.push([a, b]);
    }
  }
  return bad;
}

export function startable(config, merged, running) {
  const done = new Set(merged);
  const busy = [...running];
  const picked = [];
  const blocked = {};
  for (const id of Object.keys(config.modules)) {
    if (done.has(id) || busy.includes(id)) continue;
    const missing = (config.needs[id] ?? []).filter((dep) => !done.has(dep));
    if (missing.length > 0) {
      blocked[id] = `waits for ${missing.join(', ')}`;
      continue;
    }
    const clash = [...busy, ...picked].find((other) =>
      pathsOverlap(config.modules[id], config.modules[other]),
    );
    if (clash) {
      blocked[id] = `paths overlap ${clash}`;
      continue;
    }
    picked.push(id);
  }
  return { picked, blocked };
}

function list(value) {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function main() {
  const { values } = parseArgs({
    options: { merged: { type: 'string' }, running: { type: 'string' } },
  });
  const config = JSON.parse(readFileSync(new URL('../modules.json', import.meta.url), 'utf8'));
  const { picked, blocked } = startable(config, list(values.merged), list(values.running));
  console.log(`Start now: ${picked.join(', ') || 'none'}`);
  for (const [id, why] of Object.entries(blocked)) console.log(`  ${id}: ${why}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
