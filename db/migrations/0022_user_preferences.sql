-- ════════════════════════════════════════════════════════════════════
-- 0022_user_preferences.sql
-- ────────────────────────────────────────────────────────────────────
-- Sprint 3 (A2) — bilingual-i18n / per-user preferences.
--
-- RENUMBERED 0017 -> 0022 during the release integration merge. The
-- accounting branch had independently renumbered 0013_bilingual_catalog.sql
-- to 0017_bilingual_catalog.sql, so both branches ended up claiming 0017.
-- Git merges the two cleanly — different filenames, both pure additions —
-- but db/migrate.js keys its ledger on the 4-digit prefix (`version` is the
-- PRIMARY KEY of _migrations), so whichever file ran second would hit
-- ER_DUP_ENTRY on that INSERT and `node db/migrate.js` would exit 1. That
-- command is now release step 2/3, so the collision would have failed every
-- deploy — and it would never have surfaced as a merge conflict. THIS file
-- was the one renumbered because it has never been applied anywhere, whereas
-- 0017_bilingual_catalog.sql's number is already referenced by
-- db/migrations/README.md's guarded-DDL registry.
--
-- WHAT THIS MIGRATION DOES:
--   1) user_preferences — one row per user (PK = username), holding a
--      free-form JSON blob of that user's preferences: the UI language
--      ({ "language": "ar" | "en" }) plus any arbitrary UI preferences a
--      later feature wants to persist (saved column widths, density, etc.).
--      Backs GET/PUT /api/user-preferences (routes/user-preferences.js).
--
-- WHY THIS IS SAFE:
--   • The table is NEW — nothing here touches `users` or any other
--     existing table. `username` is a plain VARCHAR key (the same
--     token-derived identity every other route already uses); no FK is
--     declared so a preferences row can exist/outlive independently and
--     an old deploy without this table simply 500s→handled by the route,
--     never corrupts anything.
--   • prefs_json is LONGTEXT NULL so the row is valid before any pref is
--     written; the route treats NULL / unparseable JSON as {} (honest
--     empty default, never a crash).
--
-- WIRING NOTE for the server.js migration-wiring stage — same caveat as
-- 0015 / 0016: server.js's own runMigrations() (ad-hoc createTableIfMissing
-- calls), not db/migrate.js's versioned runner, is what actually executes
-- on every boot today. This migration is ALREADY wired there (search
-- "15b) User Preferences" in server.js, right after the saved_views block).
-- This file is the readable reference / fresh-install supplement — copy
-- verbatim if ever reconstructing the schema by hand. createTableIfMissing
-- no-ops safely when the table exists, so it is safe to run every boot.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_preferences (
  username    VARCHAR(80) NOT NULL PRIMARY KEY,
  prefs_json  LONGTEXT NULL,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
