import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { adrKey, adrProblems, foreignAdrs } from './check-adrs.mjs';

test('keys module ADRs by module and number, and the first six by number', () => {
  assert.equal(adrKey('M4-0001-engine-v1-rules.md'), 'M4-0001');
  assert.equal(adrKey('M12-0010-register-grid.md'), 'M12-0010');
  assert.equal(adrKey('0003-m9-jobs-and-notifications.md'), '0003');
  assert.equal(adrKey('0007-new-unprefixed.md'), null);
  assert.equal(adrKey('M4-1-short-number.md'), null);
  assert.equal(adrKey('M4-0002-Upper_Case.md'), null);
  assert.equal(adrKey('m4-0002-lowercase-prefix.md'), null);
});

test('accepts distinct names and ignores the README', () => {
  assert.deepEqual(
    adrProblems([
      'README.md',
      '0001-engine-v1-rules.md',
      '0002-pseudonymised-sample-register.md',
      'M4-0001-recurrence.md',
      'M5-0001-sessions.md',
    ]),
    [],
  );
});

test('rejects a new unprefixed ADR', () => {
  assert.equal(adrProblems(['0007-something.md']).length, 1);
});

test('rejects two ADRs with the same module and number, or the same legacy number', () => {
  assert.deepEqual(adrProblems(['M7-0001-a.md', 'M7-0001-b.md']), [
    'M7-0001-b.md: M7-0001 is already used by M7-0001-a.md',
  ]);
  assert.deepEqual(adrProblems(['0003-m3-tenant.md', '0003-m9-jobs.md']), [
    '0003-m9-jobs.md: 0003 is already used by 0003-m3-tenant.md',
  ]);
});

test('a module PR may only add ADRs under its own prefix', () => {
  assert.deepEqual(
    foreignAdrs(
      [
        'docs/adr/M4-0002-ok.md',
        'docs/adr/M5-0001-not-mine.md',
        'docs/adr/0007-unprefixed.md',
        'docs/adr/README.md',
        'packages/engine/src/a.ts',
      ],
      'M4',
    ),
    ['docs/adr/M5-0001-not-mine.md', 'docs/adr/0007-unprefixed.md'],
  );
  assert.deepEqual(foreignAdrs(['docs/adr/M1-0001-x.md'], 'M12'), ['docs/adr/M1-0001-x.md']);
});

test('the ADRs in the repo pass', () => {
  const dir = new URL('../../docs/adr/', import.meta.url);
  assert.deepEqual(adrProblems(readdirSync(dir).filter((name) => name.endsWith('.md'))), []);
});
