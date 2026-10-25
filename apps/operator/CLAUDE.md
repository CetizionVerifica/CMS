# apps/operator: the PlanetPulse operator console (M15)

Next.js App Router app for PlanetPulse staff: create and run customer accounts. Root `CLAUDE.md`,
`packages/ui/CLAUDE.md`, ADR M15-0001 and ADR M15-0003 apply. Owned by M15 with `apps/api/src/platform/`.

## How it talks to the API

- **The browser calls the operator API itself**, at `/api/platform/v1` on the console's own origin. The `op_sid`
  cookie is HttpOnly with `Path=/api/platform`, so the console's pages never see it and no server component can
  forward it. Production puts the console on its own host (for example `admin.planetpulse.life`) and the load balancer
  sends `/api/platform` to the API; `next.config.ts` rewrites the same path to `OPERATOR_API_URL` (default
  `http://localhost:4000`) for `next dev` and for a deployment without that rule. Next fixes rewrites at build time,
  so set `OPERATOR_API_URL` when running `next build`, not only at start. Either way the API sees a proxy, so
  `TRUST_PROXY` must list it and `PLATFORM_IP_ALLOWLIST` the operator's own addresses. **With the rewrite, that proxy
  is the console's own Next server**: put its address in `TRUST_PROXY` too, or the API takes every request as coming
  from the console server and the allowlist checks that address instead of the operator's. Prefer the load balancer
  rule in production, so the rewrite is never in the path.
- `lib/api.ts` takes methods, paths and schemas from the contracts' `PLATFORM_ENDPOINTS` and parses every answer.
  Never `fetch` directly. The CSRF token from `GET /me` goes on every unsafe request; a 401 sends the operator to
  `/login?next=…`. The two creating routes send an `Idempotency-Key`, one per form.
- Pages are thin client components under `app/`; each renders one screen from `lib/screens/`. Filters live in the URL.

## Rules

- **No client or personal data.** The operator API returns none and the console must not ask for it. Support access
  opens the customer app in a new tab (`window.open` with `noopener`); the console never reads what that session sees.
- **Every consequential action asks for a typed reason** (suspend, resume, convert, plan, limits, deletion). Deletion
  also asks for the account name, typed exactly.
- **Add-ons** (ADR M16-0001 decision 2): the account page has one switch per `KNOWN_FEATURES` entry. A switch changes
  only `features` and `removedFeatures`; the "Override limits" drawer changes only the limits and the flags that are
  not add-ons. The API has no read of the override, so both derive it from the entitlements and the plan
  (`overrideFrom`) and read the note back from the newest `OVERRIDE_CHANGE` in the operator audit
  (`override-note.ts`): a save never wipes another part.
- Brand: "PlanetPulse Operator Console". Never the internal project name in UI text.
- Times show in India time (`formatInstant`), dates as "31 Mar 2027", money in rupees from paise.
- The audit download is CSV with a byte-order mark for Excel; cells that could start a formula are defused
  (`lib/audit-export.ts`).
- Design-system components and tokens only. Check new screens at 1280px and 375px and keyboard-only.

## Commands

```
pnpm --filter @canopy/operator dev     # http://localhost:3200 (3100 is the e2e web port), API at OPERATOR_API_URL
pnpm --filter @canopy/operator test
```

The API needs `PLATFORM_ENABLED=true`, `OPERATOR_DATABASE_URL` and `APP_URL`; create an operator with
`pnpm --filter @canopy/api platform:add-operator --email … --name …` (password on stdin).
