import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { allNeeds, concurrentOverlaps, pathsOverlap, startable } from './plan-wave.mjs';

const config = JSON.parse(readFileSync(new URL('../modules.json', import.meta.url), 'utf8'));

test('modules that can run at the same time never own overlapping paths', () => {
  assert.deepEqual(concurrentOverlaps(config.modules, config.needs), []);
});

test('every module has a needs entry that names known modules', () => {
  assert.deepEqual(Object.keys(config.needs).sort(), Object.keys(config.modules).sort());
  for (const deps of Object.values(config.needs)) {
    for (const dep of deps) assert.ok(config.modules[dep], `unknown module ${dep}`);
  }
});

test('directory entries end in a slash', () => {
  for (const paths of [...Object.values(config.modules), config.shared]) {
    for (const path of paths)
      assert.ok(path.endsWith('/') || /\.[a-z]+$/.test(path.split('/').pop()), path);
  }
});

test('needs has no cycles', () => {
  for (const id of Object.keys(config.needs)) assert.ok(!allNeeds(id, config.needs).has(id), id);
});

test('a path overlaps itself, its parent and its children, not a sibling with a longer name', () => {
  assert.ok(pathsOverlap(['e2e/'], ['e2e/tests/shell/']));
  assert.ok(pathsOverlap(['packages/ui/'], ['packages/ui/']));
  assert.ok(!pathsOverlap(['packages/ui/'], ['packages/ui-kit/']));
});

test('waves follow MODULES.md', () => {
  assert.deepEqual(startable(config, [], []).picked, ['M0', 'M1', 'M2']);
  assert.deepEqual(startable(config, ['M1'], ['M0', 'M2']).picked, []);
  assert.deepEqual(startable(config, ['M0', 'M1', 'M2'], []).picked, ['M3', 'M4', 'M8', 'M11']);
  assert.deepEqual(startable(config, ['M0', 'M1', 'M2', 'M3', 'M4'], ['M8', 'M11']).picked, [
    'M5',
    'M6',
    'M7',
    'M9',
  ]);
});

test('says why a module cannot start', () => {
  const { blocked } = startable(config, ['M1'], ['M0']);
  assert.equal(blocked.M3, 'waits for M0');
  const fake = { modules: { A: ['x/'], B: ['x/y/'] }, needs: { A: [], B: [] } };
  assert.deepEqual(startable(fake, [], ['A']).blocked, { B: 'paths overlap A' });
});
