import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, markers } from './audit-verdict.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
let clock = 0;
// Permissions as the collaborator permission API reports them. `reader` is an org member with read-only access, whose
// author_association would still say MEMBER.
const PERMS = { shyam: 'write', owner: 'admin', reader: 'read', 'github-actions[bot]': 'none' };
const decideFor = (comments) => decide(comments, HEAD, PERMS);
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
  assert.equal(decideFor([comment(verdict(HEAD, 'Ready'))]).ok, true);
});

test('no verdict, or only one for an older sha, fails', () => {
  assert.equal(decideFor([]).ok, false);
  assert.equal(decideFor([comment(verdict(OLD, 'Ready'))]).ok, false);
});

test('the newest verdict wins, whatever order the API returns', () => {
  const ready = comment(verdict(HEAD, 'Ready'));
  const notReady = comment(verdict(HEAD, 'Not-ready'));
  assert.equal(decideFor([notReady, ready]).ok, false);
  const readyAgain = comment(verdict(HEAD, 'Ready'));
  assert.equal(decideFor([readyAgain, notReady, ready]).ok, true);
});

test('only people with write access count, whatever author_association says', () => {
  const forged = verdict(HEAD, 'Ready');
  const by = (login, extra = {}) => decideFor([comment(forged, { login, ...extra })]);
  assert.equal(by('owner', { association: 'CONTRIBUTOR' }).ok, true);
  assert.equal(by('github-actions[bot]', { type: 'Bot' }).ok, false);
  assert.equal(by('reader').ok, false);
  assert.equal(by('stranger', { association: 'NONE' }).ok, false);
  assert.match(by('reader').reason, /1 from authors without write access/);
});

test('a bot never counts, even one listed with write access', () => {
  assert.equal(decideFor([comment(verdict(HEAD, 'Ready'), { type: 'Bot' })]).ok, false);
});

test('an untrusted Ready does not override a trusted Not-ready', () => {
  const comments = [
    comment(verdict(HEAD, 'Not-ready')),
    comment(verdict(HEAD, 'Ready'), { login: 'stranger' }),
  ];
  assert.equal(decideFor(comments).ok, false);
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
