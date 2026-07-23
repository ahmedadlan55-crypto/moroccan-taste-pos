FROM node:18-alpine
WORKDIR /app

# 1) Backend production dependencies.
COPY package*.json ./
RUN npm install --production

# 2) Application source (frontend/*/dist is gitignored, so it is NEVER copied
#    here — each bundle is built fresh in the next steps).
COPY . .

# Final cutover (FC-W3) — every legacy shell is deleted from the repo. The image
# builds exactly TWO React bundles: the unified Back-Office (/app) and the React
# cashier, which now OWNS /pos (/pos-v2 is a 301 to it). Rollback is a release
# rollback, not a flag.

# 3) Build the cashier React SPA (served at /pos; base /pos/).
RUN npm run build:pos \
 && rm -rf frontend/pos/node_modules

# 4) Build the unified ADLAN Back-Office React SPA (served at /app behind
#    ERP_UNIFIED_ENABLED). The bundle ships in the image; when the flag is off
#    /app returns a 503 notice and the SPA is never mounted, so building it now
#    has no runtime effect until the flag is enabled.
RUN npm run build:erp \
 && rm -rf frontend/erp/node_modules

EXPOSE 3000

# ─── Release chain — fail-closed ────────────────────────────────────────────
# This used to be `CMD ["node", "server.js"]`, which meant the numbered
# migrations under db/migrations/ NEVER ran in production: the live schema was
# only ever whatever server.js's legacy runMigrations() built at boot.
#
# The order below is deliberate, and it is NOT the naive
# `db:init -> db:migrate -> start`:
#
#   * `db/init.js` is NOT a per-start step. It applies db/schema.sql, a job
#     server.js's autoInitDB() already does on an empty DB — and does more
#     safely, because it filters out schema.sql's hardcoded `CREATE DATABASE`
#     (which on a privilege-scoped managed credential raises "Access denied"
#     and would hard-fail the chain) and `USE` (which would redirect the pool
#     off the env-configured database). Set RUN_DB_INIT=1 for a deliberate
#     one-time bootstrap only.
#
#   * `db/migrate.js` CANNOT run straight after a bare db/schema.sql baseline:
#     the numbered migrations were authored against the schema as
#     runMigrations() had already evolved it. 0005 ALTERs `hr_employees` and
#     0014 ALTERs `pos_orders` — tables present in NEITHER schema.sql nor any
#     numbered migration; only server.js creates them. So legacy provisioning
#     must come first, and it runs as its own terminating process
#     (MIGRATE_ONLY=1) instead of as a side effect of starting the server.
#
# The chain lives in scripts/release-start.js — ONE definition, invoked
# identically here and by `npm run release:start`, so the exact command
# production runs is the one the release-chain test exercises against a
# genuinely empty database (tests/integration/releaseChain.test.js). Each step
# is a child process whose exit code is checked explicitly; a failure aborts
# before step 3, so the server can never start on an incomplete schema.
CMD ["node", "scripts/release-start.js"]
