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
  `sessionApi()`, which adds the CSRF token. `getMe()` is cached per request.
- `api/client.ts` parses every response with its Zod schema and throws `ApiError` with the contract `code`
  (`isApiError(err, 'NOT_FOUND')`).
- Until `CANOPY_API_URL` is set, `api/mock.ts` answers in-process with pseudonymous demo data (accounts are listed on
  the login page). It covers only the routes the shell calls; it goes away once M0's mock server or the real API
  answers. A production server reached on a non-local host refuses to use it (`api/mode.ts`), so a deployment
  without `CANOPY_API_URL` fails instead of offering demo logins.
- `api/client.ts` takes methods, paths and schemas from the contracts' `ENDPOINTS` table. Add a method there for each
  endpoint a page calls, rather than calling `fetch` directly.
- `api/types.ts` holds `ShellMe`: the contract's `Me` plus the per-client context the switcher and period picker need
  (contracts 1.2.0 adds it to `ClientSummary`; switch to the contract type then).

## Period

`period.ts` reads and writes `?fy=2022-23&q=Q3` (or `&m=2022-10`). `periodFromParams(searchParams)` returns undefined
when the URL has none; the API then uses the current period. The shell's picker defaults to the client's
`thisPeriod`, which the API gets from the engine.

## Page patterns (`patterns/`)

`PageHeader`, `PageLoading`, `PageEmpty`, `PageError` (for `error.tsx`, with `reset`), `NoPermission`,
`NotFoundState` and `ComingSoon`. They take plain props, so Server Components can render them.

## Top-bar action

From a Client Component: `usePrimaryAction(useMemo(() => ({ label, icon, href }), []))` puts the page's main action
in the top bar until the page unmounts.

## Phone layout on first paint

`layout-hint.ts` guesses the shell layout on the server (saved cookie, then client hints, then a phone user agent), so
phones get the bottom-sheet layout in the server HTML instead of a sidebar that jumps after hydration (spec 01).
