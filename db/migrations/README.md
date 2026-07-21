# Database Migrations

Versioned SQL migrations applied by `db/migrate.js`. **Not** at server
startup today — see the "Running" section below for the verified current
state and why.

## File naming

```
NNNN_short_description.sql
```

- `NNNN` — zero-padded 4-digit sequence number (`0001`, `0002`, ...). Determines apply order.
- `short_description` — lowercase snake_case, describes the change in 3-6 words.
- `.sql` extension required.

Examples:
- `0001_baseline_marker.sql`
- `0002_unified_workflow_schema.sql`
- `0010_audit_v2_table.sql`

## Authoring rules

1. **Immutable history.** Once a migration is deployed (applied on any environment), do **not** edit it. Add a new migration to fix or extend the prior change. The runner stores a checksum and will warn on drift.
2. **One concern per file.** Don't bundle unrelated schema changes. Keep migrations focused so they can be reasoned about and (in emergencies) rolled back by writing an inverse migration.
3. **Idempotent where possible.** Prefer `CREATE TABLE IF NOT EXISTS` or guarded `INSERT IGNORE` / `UPDATE ... WHERE`. **`ADD COLUMN IF NOT EXISTS`, `DROP INDEX IF EXISTS`, and `ADD ... KEY IF NOT EXISTS` are NOT valid syntax on real MySQL** (verified directly against this project's MySQL 8.4.9, which rejects all three with a parse error — that is a MariaDB-ism, not MySQL). For `ALTER TABLE ADD COLUMN` / index / unique-key / foreign-key changes, **guard with `INFORMATION_SCHEMA` + `PREPARE`/`EXECUTE` dynamic SQL** instead of plain unguarded DDL:
   ```sql
   SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'invoice_number');
   SET @stmt = IF(@col_exists = 0, 'ALTER TABLE sales ADD COLUMN invoice_number VARCHAR(40) NULL', 'SELECT 1');
   PREPARE stmt FROM @stmt; EXECUTE stmt; DEALLOCATE PREPARE stmt;
   ```
   (swap `INFORMATION_SCHEMA.COLUMNS`/`COLUMN_NAME` for `INFORMATION_SCHEMA.STATISTICS`/`INDEX_NAME` for indexes, or `TABLE_CONSTRAINTS`/`CONSTRAINT_TYPE='FOREIGN KEY'` for FKs). This is not optional style preference — `server.js`'s legacy `runMigrations()` boot path (see the "Relationship to legacy schema management" section below) independently adds many of the same columns via `addColumnIfMissing()`, so an unguarded `ADD COLUMN` here WILL hit "Duplicate column name" the moment both paths touch the same database, which is the normal case in this repo today (see `0002_sales_numbering.sql`, `0004`, `0005`, `0011`, `0013`, `0014`, `0015`, `0017` for real examples this broke). `MODIFY COLUMN` and `WHERE`-scoped `UPDATE` are idempotent by nature (verified directly) and don't need this guard. A genuine partial-DDL-failure mid-file is then naturally resumable too — the guard means re-running the same file only executes the steps that didn't already complete (see `0019_account_role_registry_scope_fix.sql` and `tests/integration/migrationLifecycle.test.js`'s partial-failure-then-resume scenario for the proof). The runner does not auto-retry on partial failure by itself — resumability comes from the guards, not from the runner.
4. **No statement terminators inside `BEGIN ... END`.** The splitter in `db/migrate.js` is naive (top-level `;` only). Procedures with multi-statement bodies require `DELIMITER`-style wrappers, which are not supported. Stick to plain DDL/DML.
5. **Charset/collation.** Always specify `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci` on EVERY new table, explicitly — including tables created only for local testing/fixtures. The database/server default collation here is `utf8mb4_0900_ai_ci`, not `utf8mb4_unicode_ci`; a table left on the default cannot have a foreign key to (or from) a table using the explicit `..._unicode_ci` collation — MySQL raises `ER_FK_INCOMPATIBLE_COLUMNS`. This is not hypothetical: it broke the first draft of the isolated-DB migration test for 0018/0019 (`tests/integration/migrationLifecycle.test.js`).
6. **Comments encouraged.** Open every file with a comment block explaining the *why*, not just the *what*. The migration is a permanent record of the project's evolution.

## Running

**This does NOT run automatically anywhere in this repo today** — verified
directly: `Dockerfile`'s `CMD` is `node server.js` with no migration step,
there is no `railway.json`/`railway.toml` release phase, and `server.js`
never `require()`s `db/migrate.js`. Every numbered migration only applies
when someone runs the command below by hand (locally, or as a manual step
in a deploy).

```bash
# Apply all pending migrations (a manual step — see "Recommended release
# step" below for exactly when to run this in a deploy)
npm run db:migrate   # = node db/migrate.js

# Inspect applied versions
mysql -e "SELECT version, filename, applied_at FROM moroccan_taste_pos._migrations ORDER BY version"
```

### Reconciliation with the legacy `runMigrations()` boot path — RESOLVED

Earlier revisions of this doc reported `node db/migrate.js` as blocked:
running it against any database the legacy `server.js runMigrations()`
boot path had already touched failed on 0002 with "Duplicate column",
because 0002 (and, discovered by the same real-runner test that fixed
0002 — 0004, 0005, 0011, 0013, 0014, 0015, 0017) used plain
`ALTER TABLE ... ADD COLUMN` / `CREATE INDEX` with no existence guard, so
re-running them against a schema the legacy path had already provisioned
(or a genuine second run) raised a hard error instead of a clean no-op.

**Tier A.2 corrective gate, Section 6 — fixed.** Every migration file in
this directory that adds a column, index, unique key, or foreign key now
checks `INFORMATION_SCHEMA` first via `PREPARE`/`EXECUTE` dynamic SQL
before running the DDL (MySQL 8 has no `ADD COLUMN IF NOT EXISTS` —
verified directly, that syntax is a MariaDB-ism and is a hard parse error
here — see rule 3 above). `MODIFY COLUMN` and `WHERE`-scoped
`UPDATE`/`INSERT IGNORE` statements are idempotent by nature and were left
as-is. Two ordering bugs inside `server.js runMigrations()` itself were
also fixed (a handful of `addColumnIfMissing()` calls ran before their own
target table's `createTableIfMissing()` call, later in the same function —
`pos_orders.branch_id` was the one that actually broke the test; the fix
generalizes to any table created later in that function).

Verified end-to-end via `tests/integration/migrationLifecycle.test.js`
(`npm run test:migration-lifecycle`), which drives the REAL
`db/migrate.js` runner — not a hand-copied statement list — through: a
bare/fresh DB (stops cleanly on 0002's genuine `sales` prerequisite,
nothing corrupts), a DB already provisioned by a real `server.js` boot
(every migration through the newest applies cleanly, including 0002
against columns the legacy path already added), a rerun (zero pending,
zero errors), a simulated partial-DDL-failure-then-resume on 0019 (the
whole file re-applies, no "duplicate" error on the steps that never broke),
and checksum drift detection (warned, never fatal). 15/15 checks pass.

### Recommended release step (documented only — NOT wired in)

Per this gate's mandate, nothing below is activated automatically; wiring
any of it in is a separate, explicit decision for a future change, not
implied by this documentation existing. To run migrations as a deploy step
ahead of server start (the standard pattern once a migration runner is
confirmed safe to re-run), the two options are:

1. **A platform release/predeploy command**, if the hosting platform
   supports one (e.g. Railway's `deploy.startCommand` alongside a separate
   pre-deploy step, or a Docker `ENTRYPOINT` wrapper script) —
   `npm run db:migrate && node server.js`, so the migration runs once per
   release, before the app binds its port. This repo does not currently
   define such a step in `Dockerfile` or any `railway.*` config — adding
   one is a deploy-infrastructure change outside this gate's scope and
   needs its own review (a failed migration should fail the deploy, not
   silently fall back to the old schema, so it needs an explicit rollout
   plan — see the "Rollback" note below — not a one-line addition).
2. **A manual pre-deploy step** — run `npm run db:migrate` against the
   target database before restarting/redeploying `server.js`. This is the
   current, safe, always-available option and requires no infrastructure
   change.

Either way, `server.js`'s own `runMigrations()` legacy boot path keeps
running as before (it does not know about `db/migrate.js` or `_migrations`
bookkeeping) — the two are independent and both idempotent, so applying a
migration via one path and then booting `server.js` is safe; it just means
some columns may already exist by the time `db/migrate.js` gets to them,
which the guards above now handle correctly.

## Relationship to legacy schema management

Two older mechanisms remain in place for backward compatibility:

- `db/schema.sql` + `db/init.js` — initial table creation for fresh databases via `npm run db:init`.
- `server.js runMigrations()` — startup-time ALTER TABLE / CREATE TABLE IF NOT EXISTS commands for incremental columns added in versions before this framework existed.

New schema changes belong here, in versioned files — not in either of the legacy locations. Phase 2 of the enterprise rebuild plan will start porting the contents of `runMigrations()` into numbered migrations.
