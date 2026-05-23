# Repositories Layer

Repositories are the **only** modules that issue `db.query()` calls. They expose a domain-friendly API (`findById`, `insertWithChildren`, `updateWithVersion`) and hide the underlying SQL so callers don't have to think in terms of columns and joins.

## Why this layer exists

Before this refactor, every route handler called `db.query('SELECT ...')` directly. The same JOIN appeared in dozens of places, slightly different each time — so schema changes required a multi-file search-and-replace. Repositories collapse those duplicates into one canonical query per use case.

A typical repository method:

1. Accepts plain JS arguments (no `req`, no SQL fragments).
2. Builds a parameterized query and executes it via the shared `db` pool.
3. Maps the raw rows back into a domain object (camelCase, sane types).
4. Returns that object, or `null` / `[]` if nothing matched.

## Naming

- Files use `PascalCaseRepository.js` (e.g. `TransactionRepository.js`).
- Each file exports an object of methods — same convention as services (plain functions, no classes).
- Method names are CRUD-flavoured but domain-friendly:
  - **Read:** `findById`, `findByUsername`, `listForUser`, `existsForId`
  - **Write:** `insert`, `update`, `updateWithVersion` (for optimistic locking), `softDelete`, `forceDelete`
  - **Aggregate:** `countPendingForAssignee`, `sumAmountByStatus`

## What does NOT belong here

- **Business logic** — repositories don't decide whether an operation is allowed, only whether the SQL succeeds. Permission checks live in services.
- **Multi-domain queries** — if a query spans transactions + payroll + inventory, that's a service-level concern. Repositories stay domain-scoped.
- **Cross-cutting side effects** — repositories don't emit events, don't write audit logs, don't send notifications. They read and write their own tables, nothing else.

## Conventions

- Use the shared pool from `db/connection.js` (`require('../db/connection')`). Never create new connections.
- All SQL is parameterized (`?` placeholders + args array). No string concatenation, ever.
- Return domain objects in camelCase, not raw column names. Centralize the mapping in a `_toDomain(row)` helper at the bottom of each file.
- Methods that accept a connection (`conn`) as a first argument operate inside an outer transaction. Methods without `conn` use the pool directly. Example:
  ```js
  module.exports = {
    findById(id) { /* uses pool */ },
    findByIdTx(conn, id) { /* uses caller's transaction */ }
  };
  ```
  Where this distinction matters (multi-step service operations), expose both flavors.
- Index hints, lock modifiers (`FOR UPDATE`), and other MySQL specifics live here and nowhere else — services see only the method names.

## Phased migration plan

This directory is created empty in Phase 0 of the enterprise rebuild plan and populated alongside services in Phase 1+. Each repository is born when its first service method needs it.
