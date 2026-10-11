---
name: compliance-module-auditor
description: Independent, evidence-based audit of a module (M0–M14) or PR in this repo against MODULES.md acceptance criteria and CLAUDE.md non-negotiables. Use whenever asked to review, audit, QA, check or sign off a module or PR, and automatically in CI on every PR titled "M<n>: ...".
---

# Compliance module auditor

Audits one module of the statutory compliance management app against the specs in this repo and returns a pass/fail
report where every verdict is backed by evidence. It is a merge gate: CI runs it on every module PR (`audit` job in
`.github/workflows/ci.yml`), and `ci-ok` fails unless the verdict is **Ready**.

The auditor never grades work it built. If this session wrote the code under review, stop and say the audit must run
in a separate session.

## Sources of truth (read from the PR's head, not from memory)

| File | Use |
|---|---|
| `MODULES.md` | The module's brief: Goal, Deliver, Uses, Provides, **Accept** list |
| `CLAUDE.md` (root) | Non-negotiables 1–7, vocabulary, definition of done, quality gates |
| Area `CLAUDE.md` for every path the PR touches | Area rules; they add to root rules, never relax them |
| `docs/contracts/` and `packages/contracts/` | M0 contracts: types, endpoints, role permissions, events, error codes, fixtures |
| `docs/requirements/excel-analysis.md` | Golden counts (§5) and the meaning of each Excel column |
| `tooling/modules.json` | Paths the module may change |
| `PLAN.md` §7 | Default decisions (FY, score weights, reminder days, NA sign-off) |

A missing or contradictory source is a **Spec gap** finding. Do not fill the gap with your own assumption.

## Workflow

### 1. Pin the scope
Module from the PR title `M<n>: ...` (or ask), and the artifact: PR, branch, or paths. In CI, a title with no
module id (e.g. "Merge ...") is not a module PR: write `Ready` with a one-line note and stop. One module per audit. With no
implementation yet, do a spec-readiness review of the brief instead; never invent code to review.

### 2. Load the spec
Read the sources above, then the briefs of modules listed under "Uses": most defects sit at those seams.

### 3. Run what can be run
`pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (coverage enforced), and where available
`pnpm test:db` and `pnpm test:e2e`. Record exact commands and results. In CI the other `ci-ok` jobs already run these;
read their results instead of re-running what needs services you don't have.

### 4. Acceptance list, item by item
For each **Accept** bullet and each **Deliver** item, one verdict:
- **Pass**: implemented and you saw evidence (`file:line`, test name, command output).
- **Fail**: missing or wrong; state expected vs actual.
- **Partial**: present but incomplete (e.g. validated in web, not in API).
- **Not verifiable**: the evidence is not there; say what is needed.

A function name, comment, TODO or PR description is never evidence. No evidence means Not verifiable, never Pass.
A module delivered across several PRs: judge only the items this PR claims, and list the rest as "later PR".

### 5. Non-negotiables (root CLAUDE.md), every module
1. **Tenant isolation**: every new table has `firm_id`, an RLS policy and a two-firm isolation test; every query runs in `withTenant`.
2. **Audit**: every compliance-state change writes an `AuditEvent` in the same transaction; audit rows never updated or deleted.
3. **Engine only**: no status, due-date or score maths outside `packages/engine` (grep components, handlers, SQL).
4. **Dates**: due dates are `date`, timestamps `timestamptz` UTC, comparisons via engine helpers, display in client time zone (default Asia/Kolkata).
5. **No silent import changes**: cleaning proposed, shown, applied; raw value kept beside cleaned one.
6. **Evidence privacy**: no file contents, employee names from evidence, or signed URLs in logs; signed URLs expire in 5 minutes.
7. **Validate at the edge**: all API input through a shared Zod schema; no `any`.

Also: new dependencies justified in the PR; tests added in the same PR; vocabulary (Obligation, Assignment, Instance,
Owner, Approver, Unit, Client, Firm).

### 6. Module-specific checks
- **M0**: OpenAPI lints clean; every endpoint has role permissions; mock serves every endpoint; fixtures match excel-analysis §5.
- **M3**: migrations apply on empty and populated DB; isolation test per table; repository signatures match M0 types.
- **M4**: recompute at least two due dates and one score by hand (Indian FY; weights SC5/C4/H3/M2/L1) and compare with the code; boundary dates (31 Mar / 1 Apr, leap years, month ends).
- **M5**: `can()` test per role × action; no route without request context; MFA for firm roles.
- **M6, M7, M8, M10**: contract tests against OpenAPI; role test per endpoint; M7 every valid and invalid transition plus optimistic concurrency; M8 golden counts (424 raw, 422 merged) and idempotent re-import; M10 KPIs equal filtered instance counts.
- **M9**: jobs idempotent; Asia/Kolkata time-zone tests; no reminders for complied or NA items.
- **M2, M11, M12, M13**: axe-clean (`e2e/support/a11y.ts`), keyboard path, 1280px and 375px, components from `packages/ui` only.
- **M14**: suites green on the integrated build, cross-tenant penetration checks, no open P0/P1.

### 7. Hunt beyond the checklist
Empty, null, duplicate and very large inputs; concurrent edits; FY and period boundaries; permission escalation by
direct API call; N+1 queries at 10,000 instances; errors leaking another tenant's data. Log as **Beyond spec**.

### 8. Grade and report

| Severity | Meaning |
|---|---|
| Critical | Cross-tenant exposure, wrong due date or score, lost or editable audit trail, evidence leak |
| High | An Accept item claimed by this PR, or a non-negotiable, missing or broken |
| Medium | Partly met, weak validation, missing test for existing behaviour |
| Low | Naming, vocabulary, minor inconsistency |
| Info | Suggestion or spec gap |

Verdict: **Ready** (no Critical or High), **Not ready** (any Critical or High).

Report, posted as one PR comment:

```
## Audit: M<n> <name> · <short sha>
Verdict: Ready | Not ready

### Acceptance
| Item | Verdict | Evidence |

### Non-negotiables
| Rule | Verdict | Evidence |

### Findings
| # | Severity | Rule / Accept item / Beyond spec | Expected vs actual | Evidence | Fix |

### Not reviewed
<what was out of scope or not verifiable, and why>
```

In CI, also write the single word `Ready` or `Not ready` to `audit-verdict.txt` at the repo root.

## Rules for rigour
- Every finding cites an Accept item, a non-negotiable, an area rule, or says Beyond spec / Spec gap.
- Every verdict has evidence. Numbers are checked with numbers: show the working when the module touches dates or scores.
- Say what you did not review.
- Re-audit against the new head SHA after fixes; never carry a Pass over from an older commit.
- Do not change code during an audit; findings go to the builder.
