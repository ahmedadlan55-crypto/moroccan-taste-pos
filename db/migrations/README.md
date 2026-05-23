# Database Migrations

Versioned SQL migrations applied at server startup by `db/migrate.js`.

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
3. **Idempotent where possible.** Prefer `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` (MySQL 8+) or guarded `INSERT IGNORE`. The runner does not auto-retry on partial failure, so the migration must either fully succeed or leave no trace.
4. **No statement terminators inside `BEGIN ... END`.** The splitter in `db/migrate.js` is naive (top-level `;` only). Procedures with multi-statement bodies require `DELIMITER`-style wrappers, which are not supported. Stick to plain DDL/DML.
5. **Charset/collation.** Always specify `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci` on new tables to match the rest of the schema.
6. **Comments encouraged.** Open every file with a comment block explaining the *why*, not just the *what*. The migration is a permanent record of the project's evolution.

## Running

```bash
# Apply all pending migrations (also runs automatically at server start)
node db/migrate.js

# Inspect applied versions
mysql -e "SELECT version, filename, applied_at FROM moroccan_taste_pos._migrations ORDER BY version"
```

## Relationship to legacy schema management

Two older mechanisms remain in place for backward compatibility:

- `db/schema.sql` + `db/init.js` — initial table creation for fresh databases via `npm run db:init`.
- `server.js runMigrations()` — startup-time ALTER TABLE / CREATE TABLE IF NOT EXISTS commands for incremental columns added in versions before this framework existed.

New schema changes belong here, in versioned files — not in either of the legacy locations. Phase 2 of the enterprise rebuild plan will start porting the contents of `runMigrations()` into numbered migrations.
