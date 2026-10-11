import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, markers } from './audit-verdict.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
let clock = 0;
const comment = (body, { login = 'shyam', type = 'User', association = 'MEMBER' } = {}) => ({
  body,
  user: { login, type },
  author_association: association,
  created_at: new Date(Date.UTC(2026, 9, 11, 12, clock++)).toISOString(),
  html_url: `https://example.test/c/${clock}`,
});
const verdict = (sha, v) =>
  `## Audit\n\n<!-- canopy-audit sha=${sha} verdict=${v} -->\n\n---\n_footer_`;

test('a Ready verdict for the head sha from a member passes', () => {
  assert.equal(decide([comment(verdict(HEAD, 'Ready'))], HEAD).ok, true);
});

test('no verdict, or only one for an older sha, fails', () => {
  assert.equal(decide([], HEAD).ok, false);
  assert.equal(decide([comment(verdict(OLD, 'Ready'))], HEAD).ok, false);
});

test('the newest verdict wins, whatever order the API returns', () => {
  const ready = comment(verdict(HEAD, 'Ready'));
  const notReady = comment(verdict(HEAD, 'Not-ready'));
  assert.equal(decide([notReady, ready], HEAD).ok, false);
  const readyAgain = comment(verdict(HEAD, 'Ready'));
  assert.equal(decide([readyAgain, notReady, ready], HEAD).ok, true);
});

test('bots and outside commenters cannot pass the gate', () => {
  const forged = verdict(HEAD, 'Ready');
  assert.equal(
    decide([comment(forged, { login: 'github-actions[bot]', type: 'Bot' })], HEAD).ok,
    false,
  );
  assert.equal(decide([comment(forged, { association: 'CONTRIBUTOR' })], HEAD).ok, false);
  assert.equal(decide([comment(forged, { association: 'NONE' })], HEAD).ok, false);
  assert.match(decide([comment(forged, { association: 'NONE' })], HEAD).reason, /1 from untrusted/);
});

test('an untrusted Ready does not override a trusted Not-ready', () => {
  const comments = [
    comment(verdict(HEAD, 'Not-ready')),
    comment(verdict(HEAD, 'Ready'), { association: 'NONE' }),
  ];
  assert.equal(decide(comments, HEAD).ok, false);
});

test('the marker must be exact and on its own line', () => {
  assert.deepEqual(markers(`text <!-- canopy-audit sha=${HEAD} verdict=Ready -->`), []);
  assert.deepEqual(markers(`<!-- canopy-audit sha=${HEAD.slice(0, 7)} verdict=Ready -->`), []);
  assert.deepEqual(markers(`<!-- canopy-audit sha=${HEAD} verdict=ready -->`), []);
  assert.deepEqual(markers(`<!-- canopy-audit sha=${HEAD} verdict=Ready -->\r`), [
    { sha: HEAD, verdict: 'Ready' },
  ]);
  assert.deepEqual(markers(null), []);
});
