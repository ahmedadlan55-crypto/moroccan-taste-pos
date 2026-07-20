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
3. **Idempotent where possible.** Prefer `CREATE TABLE IF NOT EXISTS` or guarded `INSERT IGNORE` / `UPDATE ... WHERE`. **`ADD COLUMN IF NOT EXISTS`, `DROP INDEX IF EXISTS`, and `ADD ... KEY IF NOT EXISTS` are NOT valid syntax on real MySQL** (verified directly against this project's MySQL 8.4.9, which rejects all three — that is a MariaDB-ism, not MySQL). For plain `ALTER TABLE ADD COLUMN` / index changes, write them as normal (non-guarded) DDL and rely on `_migrations` bookkeeping to prevent a second run — a genuine partial-failure recovery still needs a human to check `SHOW CREATE TABLE` before retrying (see item 0018/0019's corrective migration, `0019_account_role_registry_scope_fix.sql`, for the documented pattern). The runner does not auto-retry on partial failure, so the migration must either fully succeed or leave no trace.
4. **No statement terminators inside `BEGIN ... END`.** The splitter in `db/migrate.js` is naive (top-level `;` only). Procedures with multi-statement bodies require `DELIMITER`-style wrappers, which are not supported. Stick to plain DDL/DML.
5. **Charset/collation.** Always specify `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci` on EVERY new table, explicitly — including tables created only for local testing/fixtures. The database/server default collation here is `utf8mb4_0900_ai_ci`, not `utf8mb4_unicode_ci`; a table left on the default cannot have a foreign key to (or from) a table using the explicit `..._unicode_ci` collation — MySQL raises `ER_FK_INCOMPATIBLE_COLUMNS`. This is not hypothetical: it broke the first draft of the isolated-DB migration test for 0018/0019 (`tests/integration/migrationLifecycle.test.js`).
6. **Comments encouraged.** Open every file with a comment block explaining the *why*, not just the *what*. The migration is a permanent record of the project's evolution.

## Running

**This does NOT run automatically anywhere in this repo today** — verified
directly: `Dockerfile`'s `CMD` is `node server.js` with no migration step,
there is no `railway.json`/`railway.toml` release phase, and `server.js`
never `require()`s `db/migrate.js`. Every numbered migration only applies
when someone runs the command below by hand (locally, or as a manual step
in a deploy). This is a real, pre-existing gap — not specific to any one
migration — and wiring it into an automatic step (a Docker/Railway release
phase, not `server.js`'s request-serving boot path) is tracked as
follow-up work, blocked on first reconciling `_migrations` bookkeeping for
migrations 0002+ against the legacy `runMigrations()` path in `server.js`,
which already created several of the same columns those files also try to
add (running `node db/migrate.js` today fails on 0002 with "Duplicate
column" for exactly this reason, on any database the legacy path has
already touched).

```bash
# Apply all pending migrations (a manual step — see the note above)
node db/migrate.js

# Inspect applied versions
mysql -e "SELECT version, filename, applied_at FROM moroccan_taste_pos._migrations ORDER BY version"
```

## Relationship to legacy schema management

Two older mechanisms remain in place for backward compatibility:

- `db/schema.sql` + `db/init.js` — initial table creation for fresh databases via `npm run db:init`.
- `server.js runMigrations()` — startup-time ALTER TABLE / CREATE TABLE IF NOT EXISTS commands for incremental columns added in versions before this framework existed.

New schema changes belong here, in versioned files — not in either of the legacy locations. Phase 2 of the enterprise rebuild plan will start porting the contents of `runMigrations()` into numbered migrations.
