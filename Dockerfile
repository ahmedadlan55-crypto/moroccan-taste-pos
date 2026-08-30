FROM node:18-alpine
WORKDIR /app

# 0) Chromium + an Arabic font, for server-side report PDFs.
#
# WHY A BROWSER: Arabic is cursive and bidirectional. A JS PDF writer draws
# glyphs at coordinates — no shaping, no bidi — so it renders Arabic as
# disconnected letters in reverse order: a document that LOOKS like a report and
# is unreadable, on paper somebody signs. Chromium already shapes correctly and
# already renders this exact print stylesheet, so the PDF and the printed page
# stay one artifact instead of two that drift.
#
# WHY `|| true`: this is an OS package fetched at build time. If the mirror is
# down or the package is renamed, the DEPLOY MUST STILL SHIP — a report export
# format is not worth a failed release of the whole ERP. services/reports/
# PdfService.js probes for the binary at runtime and answers a coded 503 when it
# is absent, and the browser print path (same document) never stops working.
# So this line degrades one button; it can never break a deployment.
RUN apk add --no-cache chromium font-noto-arabic ttf-freefont || true
ENV PDF_CHROMIUM_PATH=/usr/bin/chromium-browser

# 1) Backend production dependencies.
COPY package*.json ./
RUN npm install --production

# 2) Application source (frontend/*/dist is gitignored, so it is NEVER copied
#    here — each bundle is built fresh in the next steps).
COPY . .

# The image builds THREE React bundles: the cashier (/pos), the unified
# Back-Office (/app), and the employee portal (/employee). Rollback is a release
# rollback, not a flag.
#
# EVERY bundle needs a line here. server.js mounts each SPA only if its
# dist/index.html exists — so a missing build step is not a crash, it is a
# SILENT downgrade: the route falls back and the app is simply absent in
# production while every local check stays green. That is exactly what happened
# to the portal on its first deploy.

# 3) Build the cashier React SPA (served at /pos; base /pos/).
RUN npm run build:pos \
 && rm -rf frontend/pos/node_modules

# 4) Build the unified ADLAN Back-Office React SPA (served at /app behind
#    ERP_UNIFIED_ENABLED). The bundle ships in the image; when the flag is off
#    /app returns a 503 notice and the SPA is never mounted, so building it now
#    has no runtime effect until the flag is enabled.
RUN npm run build:erp \
 && rm -rf frontend/erp/node_modules

# 5) Build بوابة الموظف — the employee self-service PWA (served at /employee;
#    base /employee/). Its service worker and manifest come from public/, so the
#    installable app is whatever this step emits.
RUN npm run build:portal \
 && rm -rf frontend/portal/node_modules

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
