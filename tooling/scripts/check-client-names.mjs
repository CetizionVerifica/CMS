#!/usr/bin/env node
// Real client names (tooling/client-names.json) must not appear in tracked files: test data, fixtures, demos and docs
// use fictional names. The match is case-insensitive and also finds a name inside a longer word. Binary files are
// skipped (a NUL byte in the first 8 KB, as git does). Lists every file that still has one, with line numbers.
//
// Usage: node tooling/scripts/check-client-names.mjs [repo-root]   (default: the current directory)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DENYLIST = 'tooling/client-names.json';

export function loadDenylist(root) {
  const { names, exempt } = JSON.parse(readFileSync(join(root, DENYLIST), 'utf8'));
  return { names, exempt: new Set(exempt) };
}

export function namePattern(names) {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|'), 'gi');
}

/** The 1-based line numbers of `text` with a denied name and the distinct names found (lower case). */
export function findNames(text, pattern) {
  const lines = [];
  const found = new Set();
  text.split('\n').forEach((line, index) => {
    const matches = line.match(pattern);
    if (!matches) return;
    lines.push(index + 1);
    for (const match of matches) found.add(match.toLowerCase());
  });
  return { lines, names: [...found].sort() };
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/** `{ file, lines, names }` for each tracked file outside `exempt` that names a client. */
export function scan(root, files, { names, exempt }) {
  const pattern = namePattern(names);
  const dirty = [];
  for (const file of files) {
    if (exempt.has(file)) continue;
    let buffer;
    try {
      buffer = readFileSync(join(root, file));
    } catch {
      continue; // deleted in the working tree, or a submodule
    }
    if (isBinary(buffer)) continue;
    const hit = findNames(buffer.toString('utf8'), pattern);
    if (hit.lines.length > 0) dirty.push({ file, ...hit });
  }
  return dirty;
}

function lineList(lines) {
  return lines.length > 10
    ? `${lines.slice(0, 10).join(', ')} and ${lines.length - 10} more`
    : lines.join(', ');
}

function main() {
  const root = process.argv[2] ?? '.';
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const dirty = scan(root, files, loadDenylist(root));
  if (dirty.length > 0) {
    console.error(
      `${dirty.length} tracked file(s) name a real client (${DENYLIST}). Use fictional names:`,
    );
    for (const { file, lines, names } of dirty)
      console.error(`  ${file}: ${names.join(', ')} on line ${lineList(lines)}`);
    process.exit(1);
  }
  console.log(`No tracked file names a real client (${files.length} files checked).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
