#!/usr/bin/env node
// Decides the `module-audit` gate from PR comments, without calling any model API (root CLAUDE.md "Quality gates").
// An audit session that did not build the PR runs .claude/skills/compliance-module-auditor and posts its report as a PR
// comment containing, on a line of its own:
//
//   <!-- canopy-audit sha=<40-char head sha> verdict=Ready -->      (or verdict=Not-ready)
//
// The gate passes only when the newest such marker for the PR's current head SHA says Ready and was posted by a person
// with write access to the repo (checked through the collaborator permission API, because `author_association` hides
// private org membership from the Actions token and counts read-only collaborators). Markers for an older SHA never
// count, so every push needs a new audit; a later Not-ready overrides an earlier Ready; bots (including this repo's own
// workflows) and people without write access are ignored, so a drive-by comment can't pass the gate. A PR that edits
// this script or ci.yml still runs its own copy on `pull_request`; the audit of such a PR is what catches that.
//
// Usage: node .github/scripts/audit-verdict.mjs <head-sha> <comments.json> <permissions.json>
//   comments.json is the array from GET /repos/{owner}/{repo}/issues/{pr}/comments (all pages).
//   permissions.json maps each marker author's login to `permission` from
//   GET /repos/{owner}/{repo}/collaborators/{login}/permission (admin, write, read or none).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TRUSTED = new Set(['admin', 'maintain', 'write']);
const MARKER = /^\s*<!-- canopy-audit sha=([0-9a-f]{40}) verdict=(Ready|Not-ready) -->\s*$/;

export function markers(body) {
  return (body ?? '')
    .split(/\r?\n/)
    .map((line) => MARKER.exec(line))
    .filter(Boolean)
    .map(([, sha, verdict]) => ({ sha, verdict }));
}

export function trusted(comment, permissions) {
  return comment.user?.type === 'User' && TRUSTED.has(permissions[comment.user.login]);
}

// The newest trusted verdict for `sha`, or why there is none.
export function decide(comments, sha, permissions) {
  const sorted = [...comments].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  let found = null;
  let ignored = 0;
  for (const comment of sorted) {
    for (const marker of markers(comment.body)) {
      if (marker.sha !== sha) continue;
      if (!trusted(comment, permissions)) {
        ignored += 1;
        continue;
      }
      found = { ...marker, by: comment.user.login, url: comment.html_url };
    }
  }
  if (!found) {
    const extra = ignored ? ` (${ignored} from authors without write access ignored)` : '';
    return { ok: false, reason: `No audit verdict for ${sha}${extra}.` };
  }
  const ok = found.verdict === 'Ready';
  return {
    ok,
    reason: `Audit of ${sha} by ${found.by}: ${ok ? 'Ready' : 'Not ready'} (${found.url}).`,
  };
}

function main() {
  const [sha, file, permissionsFile] = process.argv.slice(2);
  if (!/^[0-9a-f]{40}$/.test(sha ?? '') || !file || !permissionsFile) {
    console.error('Usage: audit-verdict.mjs <head-sha> <comments.json> <permissions.json>');
    process.exit(2);
  }
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const { ok, reason } = decide(read(file), sha, read(permissionsFile));
  console.log(
    ok ? reason : `::error::${reason} Audit this commit in a separate session and post the report.`,
  );
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
