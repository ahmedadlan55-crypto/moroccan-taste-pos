# Services Layer

Domain services — the application's **business logic** lives here. Controllers (Express route handlers) delegate to services; services orchestrate repositories and domain modules to perform the actual work.

## Why this layer exists

Before this refactor, route handlers in `routes/workflow.js` and `routes/erp.js` ran ~200 lines of SQL + validation + side effects per endpoint. Several pain points followed:

- **Untestable.** Logic was bound to `req`/`res` so unit tests needed an HTTP server.
- **Duplicated.** The same "resolve next assignee" code appeared in multiple handlers, drifting over time.
- **Mixed concerns.** Permission checks, SQL queries, audit writes, and notification dispatches were all interleaved.

The service layer extracts business logic into pure-Node modules. A typical service method:

1. Validates the operation is allowed (delegates to a permission engine).
2. Loads required state via repositories (DB-agnostic interface, see `../repositories/`).
3. Performs the state transition via the relevant domain module (`lib/transactionStateMachine.js`, etc).
4. Persists the new state, audit event, and any emitted notifications — typically inside one DB transaction.
5. Returns a domain object the controller can format for the client.

## Naming

- Files use `PascalCaseService.js` (e.g. `TransactionService.js`).
- Each file exports an object of methods — no classes, no `new`. Use plain functions and an explicit `module.exports`. This keeps the API surface obvious from a single `grep` and avoids `this`-binding pitfalls.
- Public methods are verbs (`create`, `transition`, `resolveAssignee`) — not nouns.

## What does NOT belong here

- **HTTP concerns** — no `req`, `res`, or status codes. Throw domain errors; the controller decides the HTTP mapping.
- **SQL** — services never call `db.query()` directly. Repositories own that.
- **Cross-cutting middleware** — auth/audit/validation belongs in `routes/` middleware or `lib/`. Services receive an already-authenticated `actor` parameter.

## Conventions

- Every method takes an explicit `actor` parameter (the username + role acting), never reads from `req.user`. This is what makes services callable from CLIs, jobs, and tests.
- Errors are thrown, not returned as `{success:false}`. Controllers translate to 4xx/5xx. Services define their own error subclasses where useful (`PermissionDeniedError`, `WorkflowConflictError`).
- Database transactions are opened and committed inside the service, not the controller. If a service needs to chain side effects across multiple repos, wrap them in `db.withTransaction(async (conn) => ...)` from `db/connection.js`.

## Phased migration plan

This directory is created empty in Phase 0 of the enterprise rebuild plan and populated in Phase 1+. The intent is to migrate logic **endpoint by endpoint**, not all at once — see `docs/adr/0001-strangler-fig.md`.
