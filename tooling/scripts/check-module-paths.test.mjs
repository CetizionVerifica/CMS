import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleFromTitle, outOfScope } from './check-module-paths.mjs';

test('reads the module id from the PR title', () => {
  assert.equal(moduleFromTitle('M4: recurrence rules'), 'M4');
  assert.equal(moduleFromTitle('[m12] register grid'), 'M12');
  assert.equal(moduleFromTitle('Fix typo in README'), null);
  assert.equal(moduleFromTitle('M100 is not a module'), null);
});

test('flags files outside owned and shared paths', () => {
  const owned = ['packages/engine/'];
  const shared = ['pnpm-lock.yaml'];
  assert.deepEqual(
    outOfScope(
      ['packages/engine/src/a.ts', 'pnpm-lock.yaml', 'packages/db/src/x.ts'],
      owned,
      shared,
    ),
    ['packages/db/src/x.ts'],
  );
});

test('a prefix does not match a sibling directory with a longer name', () => {
  assert.deepEqual(outOfScope(['packages/ui-kit/a.ts'], ['packages/ui/'], []), [
    'packages/ui-kit/a.ts',
  ]);
});
