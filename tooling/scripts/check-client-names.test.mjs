import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findNames, loadDenylist, namePattern, scan } from './check-client-names.mjs';

// Names come from the denylist itself, so this file names no client.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const denylist = loadDenylist(repoRoot);
const [first, second] = denylist.names;
const upper = (s) => s.toUpperCase();
const title = (s) => s[0].toUpperCase() + s.slice(1);

test('the denylist exempts itself, holds lower-case names and has at least two', () => {
  assert.ok(denylist.exempt.has('tooling/client-names.json'));
  assert.ok(denylist.names.length >= 2);
  for (const name of denylist.names) assert.equal(name, name.toLowerCase());
});

test('matches any case, inside longer words, and reports lines and distinct names', () => {
  const text = `ok\n${title(first)} Group\nnothing\nx${upper(second)}y and ${first}`;
  assert.deepEqual(findNames(text, namePattern(denylist.names)), {
    lines: [2, 4],
    names: [first, second].sort(),
  });
});

test('clean text has no hits, and the pattern is reusable across calls', () => {
  const pattern = namePattern(denylist.names);
  assert.deepEqual(findNames('Northwind Metals, Plant 2', pattern), { lines: [], names: [] });
  assert.equal(findNames(first, pattern).lines.length, 1);
  assert.equal(findNames(first, pattern).lines.length, 1);
});

test('scan skips exempt and binary files and lists the dirty ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'client-names-'));
  writeFileSync(join(dir, 'clean.ts'), 'const client = "Northwind";\n');
  writeFileSync(join(dir, 'dirty.ts'), `// fine\nconst client = "${title(first)}";\n`);
  writeFileSync(join(dir, 'allowed.mjs'), `${first}\n`);
  writeFileSync(
    join(dir, 'blob.xlsx'),
    Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(first)]),
  );
  const files = ['clean.ts', 'dirty.ts', 'allowed.mjs', 'blob.xlsx', 'missing.ts'];
  assert.deepEqual(scan(dir, files, { names: denylist.names, exempt: new Set(['allowed.mjs']) }), [
    { file: 'dirty.ts', lines: [2], names: [first] },
  ]);
});

test('the pattern escapes regex characters in names', () => {
  assert.deepEqual(findNames('a.b and axb', namePattern(['a.b'])), { lines: [1], names: ['a.b'] });
  assert.deepEqual(findNames('axb', namePattern(['a.b'])), { lines: [], names: [] });
});

test('words match only as whole words, in any case', () => {
  const pattern = namePattern([], ['abc']);
  assert.deepEqual(findNames('xabcx\nmy abc site\nABC-group\nabcd', pattern), {
    lines: [2, 3],
    names: ['abc'],
  });
  for (const word of denylist.words) assert.equal(word, word.toLowerCase());
  const [word] = denylist.words;
  const dir = mkdtempSync(join(tmpdir(), 'client-words-'));
  writeFileSync(join(dir, 'inside.ts'), `const x${word}y = 1;\n`);
  writeFileSync(join(dir, 'alone.ts'), `// ${title(word)} plant\n`);
  assert.deepEqual(scan(dir, ['inside.ts', 'alone.ts'], denylist), [
    { file: 'alone.ts', lines: [1], names: [word] },
  ]);
});
