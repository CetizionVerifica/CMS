# Contracts changelog

## 1.0.0-draft · 2026-10-11
First draft of domain model, API conventions, endpoints with role permissions, event catalogue, error codes and fixture plan.

## 1.0.0-draft.1 · 2026-10-11
fixtures.md §3: six non-standard external IDs listed (was two).

## 1.0.0 · 2026-10-11
Domain model published as v1 in code (`packages/contracts`): primitives, every enum in domain-model.md §2, entity
Zod schemas for §3-8, engine function signatures (`EngineApi`), default firm and client settings, and error codes with
their HTTP statuses (api-conventions.md §5). Consistency rules the spec implied are now enforced; see README decisions 8-14.
