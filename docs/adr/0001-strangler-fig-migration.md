# ADR-0001: Strangler Fig Migration to Layered Architecture

- **Status:** Accepted
- **Date:** 2026-05-23
- **Decision drivers:** Plan in `~/.claude/plans/virtual-swimming-riddle.md` — Enterprise Transaction System Rebuild

## Context

The transaction subsystem of `moroccan-taste-pos` has grown into a 3,697-line `routes/workflow.js`, a 33,242-line `public/js/erp.js`, and a 4,879-line `server.js` with 30+ ALTER TABLE statements running on every startup. Despite some healthy modules (`lib/transactionStateMachine.js`, `lib/transactionPermissions.js`, `lib/transactionGuards.js`, `lib/auditLogger.js` hash chain), the system has accumulated:

- Two parallel workflow models (`workflow_definitions` per-type and `position_workflow_steps` per-position) that occasionally route the same transaction to different approvers.
- Permission decisions hardcoded in `lib/transactionPermissions.js` while the `permissions_v3` table sits empty.
- Business logic inlined into route handlers, making unit tests require an HTTP server.
- Schema mutations applied via `server.js runMigrations()` with no version tracking — environments can drift.

The owner has asked for an **enterprise-grade rebuild** that produces a true Workflow Engine + Permission Engine + Audit System + Notification Bus, while **maintaining backward compatibility** with the live production system.

## Decision

We adopt the **Strangler Fig pattern** — named after the vine that gradually envelops and replaces its host tree without ever cutting it down.

Concretely:

1. **No big-bang rewrite.** The legacy code paths (`routes/workflow.js`, `server.js runMigrations`, `db/init.js`) remain functional throughout the migration. They are *frozen* (no new features added) but stay live until every dependent caller has migrated to the new layer.

2. **New code lives in new directories.** `services/`, `repositories/`, and `db/migrations/` are created in Phase 0. Each new feature or migrated endpoint adds files here, never edits the legacy file beyond the surgical change that delegates to the new layer.

3. **Endpoint-by-endpoint migration.** Phase 1 migrates exactly three handlers (`POST /transactions`, `POST /transactions/:id/action`, `DELETE /transactions/:id/force`) to use `services/TransactionService`. The other 51 handlers stay in their current shape. Subsequent phases migrate batches as the new infrastructure matures.

4. **Shared domain modules continue to be reused.** `lib/transactionStateMachine.js`, `lib/transactionPermissions.js`, `lib/transactionGuards.js`, `lib/transactionSchema.js`, `lib/sodValidator.js`, and `lib/auditLogger.js` are NOT rewritten — they encode well-tested invariants and are simply called from inside the new services.

5. **Schema changes go through versioned migrations.** `db/migrate.js` reads numbered SQL files from `db/migrations/`. The legacy `server.js runMigrations()` stays in place but is frozen — its contents will be migrated into numbered files in Phase 2+.

## Consequences

### Positive

- **No downtime, no big-bang.** Every commit can be deployed independently. If a migrated endpoint regresses, the fix is localized — the legacy handlers are untouched.
- **Testable in isolation.** Services and repositories are plain-Node modules with no HTTP dependencies. They can be exercised by `node --test` without a running server.
- **Clear blast radius.** Each phase has a documented scope. Reviewers can verify "this commit only touches X" against the plan.
- **Reversible.** Until the legacy code is finally removed (no earlier than Phase 9), any phase can be rolled back by reverting its commits without disturbing the rest.

### Negative

- **Duplication during the transition.** For some period, the same logic exists in both the legacy route and the new service. This is the explicit cost of the pattern — we accept it for the safety it buys.
- **Discipline required.** It is tempting to "just edit the legacy file" when a hotfix is needed. The team commits to landing hotfixes via the new layer where the endpoint has already migrated, and only patching the legacy path when no migrated version exists yet.
- **Schema management is split.** Until Phase 2 finishes, schema changes can land in either `db/migrations/` (new) or `server.js runMigrations()` (legacy). New changes must go to the migrations directory; the legacy block is read-only.

## Alternatives considered

- **Big-bang rewrite into a new repo.** Rejected. Would require parallel maintenance of two systems, doubles bug surface, and the owner explicitly asked to "maintain compatibility with the existing system."
- **In-place refactor of `routes/workflow.js`.** Rejected. The file is too large to touch safely in one go, and there's no test coverage to catch regressions. Strangler Fig is the lower-risk path.
- **Adopt an ORM (Sequelize, TypeORM, Prisma).** Deferred. Repository pattern gives us 80% of the benefit at 5% of the disruption. An ORM can be introduced inside the repository layer later without changing service callers.

## References

- Plan: `~/.claude/plans/virtual-swimming-riddle.md`
- Phase 1 scope: `services/TransactionService.js`, `repositories/TransactionRepository.js`, surgical edits to `routes/workflow.js`
- Pattern origin: Martin Fowler — Strangler Fig Application (2004)
