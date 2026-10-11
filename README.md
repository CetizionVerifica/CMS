# Canopy

Multi-client statutory compliance management for a consultancy. Start with [`CLAUDE.md`](CLAUDE.md), then
[`PLAN.md`](PLAN.md) and the module briefs in [`MODULES.md`](MODULES.md).

## Requirements

- Node 22 (`.nvmrc`) and pnpm 10 (`corepack enable` picks the pinned version)
- Docker, for local Postgres 16 and S3-compatible storage

## Commands

```
pnpm install
pnpm dev            # starts Postgres + S3 (docker/compose.yaml), then web on :3000 and api on :4000
pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e       # builds, then runs Playwright against the built web app and the api
pnpm db:down        # stops local services (data kept in docker volumes)
```

Local service settings are in [`.env.example`](.env.example).

## Layout

| Path                     | Module                                  |
| ------------------------ | --------------------------------------- |
| `apps/web`               | M11–M13 (Next.js)                       |
| `apps/api`               | M5–M10 (Fastify)                        |
| `packages/contracts`     | M0                                      |
| `packages/ui`            | M2                                      |
| `packages/db`            | M3                                      |
| `packages/engine`        | M4                                      |
| `packages/importer`      | M8                                      |
| `packages/notifications` | M9                                      |
| `e2e`                    | M14                                     |
| `tooling`, `docker`, CI  | M1                                      |

Ownership is enforced by [`.github/CODEOWNERS`](.github/CODEOWNERS).
