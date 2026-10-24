# apps/web/lib (M11)

Shared code for every web screen. M12 and M13 import from here; they don't change it (ask M11 through the coordinator).

## Routes and the shell

- `app/(shell)/layout.tsx` wraps every signed-in page in the AppShell. A page only renders its content, starting with
  one `h1` (use `PageHeader`).
- `routes.ts` is the route table. The sidebar, the client switcher and the `[...stub]` placeholders read it. A new
  `page.tsx` under `app/(shell)/...` replaces the stub for that path automatically.
- The client switcher keeps the section and query string and drops record ids (`switchClientHref`).
- `app/(shell)/c/[clientId]/layout.tsx` returns 404 for a client the user can't see, so client pages can trust the id.

## Data

- Server Components: `serverApi()` from `api/server.ts` (forwards the session cookie). For state-changing calls use
  `sessionApi()`, which adds the CSRF token. `getMe()` is cached per request, and briefly per session (`api/session-cache.ts`).
- `api/client.ts` parses every response with its Zod schema and throws `ApiError` with the contract `code`
  (`isApiError(err, 'NOT_FOUND')`).
- Until `CANOPY_API_URL` is set, `api/mock.ts` answers in-process with pseudonymous demo data (accounts are listed on
  the login page). It answers the shell's routes itself (sign-in, `/me`, portfolio, approvals count) and hands every
  other endpoint to M0's mock server (`api/mock-delegate.ts`, firm B's synthetic data, in-process). Demo Metals and
  Northwind Textiles map to firm B's two clients there, so client pages get real contract data under our ids and
  names; Sunrise Foods has no data (NOT_FOUND). M0's mock runs at firm B's "today" (`FIRM_B_AS_OF`, 2024-11-15), and each demo
  client opens on the period holding it: FY 2024-25 Q3, or Q4 for Northwind Textiles, which keeps Harbour Retail
  Group's January financial year. A production build uses it only with `CANOPY_DEMO_API=1` (`api/mode.ts`, server env only), so a
  deployment without `CANOPY_API_URL` fails instead of offering demo logins.
- `api/client.ts` takes methods, paths and schemas from the contracts' `ENDPOINTS` table. Call any endpoint by name,
  never `fetch` directly: `api.call('listInstances', { params: { clientId }, query: { status: 'OVERDUE', limit: '50' } })`.
  `query` and `body` are typed as the contract's input, the query is serialised as api-conventions.md §3 says (arrays
  comma-separated) and the response is parsed with the endpoint's schema.
- `proxy.ts` sends a Content-Security-Policy with a fresh nonce per response (`security/csp.ts`); Next puts the nonce on
  its own scripts, and the root layout renders every page per request so none is prerendered without it. Browser
  uploads go straight to object storage, so a deployment sets `CANOPY_CSP_CONNECT_SRC` to the storage origin of the
  presigned upload URLs (space-separated bare https origins, or http to localhost, 127.0.0.1 or [::1] for local and CI storage;
  anything else is left out with a warning at start-up);
  unset, `connect-src` is `'self'` only. `CANOPY_CSP_REPORT_ONLY=true` sends the same policy as
  `Content-Security-Policy-Report-Only` for a trial: violations show in the browser console, nothing is blocked. In e2e, wait with a function, not a
  string: `page.waitForFunction('…')` evaluates the string in the page, which the policy refuses.
- The sidebar's Approvals item shows the count from `GET /me/approvals` for approvers and client admins. That count
  covers every client the user approves in (the endpoint has no client filter), and its label says so.
- Unit tests next to a route (`app/**/*.test.{ts,tsx}`) run with the web tests; non-page files under `app/`
  count for coverage (pages, layouts, `loading`, `error` and `not-found` are covered by Playwright).
- `Me.clients` carries each client's FY start, time zone, unit count and period context (contracts 1.1), which the
  switcher and the period picker read.

## Sign-in

`auth/actions.ts` holds the Server Actions behind the auth pages. When an email signs in to more than one firm, the API
answers 409 `FIRM_CHOICE_REQUIRED` with the firms. The sign-in form then lists them as radios with none picked, asks
for the password again and sends `firmId`. The list stays in the form state until the email changes. In the demo,
`twofirms@demo.test` shows this.

## Period

`period.ts` reads and writes `?fy=2022-23&q=Q3` (or `&m=2022-10`). `periodFromParams(searchParams)` returns undefined
when the URL has none; the API then uses the current period. The shell's picker defaults to the client's
`thisPeriod`, which the API gets from the engine.

`periodApiQuery(period, fyStartMonth)` turns the period into API query values: `{ fy }` for a whole FY, otherwise the
quarter's or month's inclusive `{ from, to }` dates (map them onto the endpoint's names, e.g. `dueFrom`/`dueTo`).

## Page patterns (`patterns/`)

`PageHeader`, `PageLoading`, `PageEmpty`, `PageError` (for `error.tsx`, with `reset`), `NoPermission`,
`NotFoundState` and `ComingSoon`. They take plain props, so Server Components can render them.

## Top-bar action

From a Client Component: `usePrimaryAction(useMemo(() => ({ label, icon, href }), []))` puts the page's main action
in the top bar until the page unmounts.

## Phone layout on first paint

`layout-hint.ts` guesses the shell layout on the server (saved cookie, then client hints, then a phone user agent), so
phones get the bottom-sheet layout in the server HTML instead of a sidebar that jumps after hydration (spec 01).
