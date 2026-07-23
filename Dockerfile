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
# B5 — fail-closed release chain. Migrations run FIRST as a dedicated step
# (MIGRATE_ONLY=1 provisions the schema under a DB advisory lock, then does a
# real `SELECT 1` and exits non-zero if the schema is NOT ready) — so a failed
# migration aborts the deploy instead of serving a half-migrated schema. Only on
# its success (`&&`) does the HTTP server start (its own boot re-runs the now-
# idempotent migrations quickly, still under the advisory lock). Concurrent
# instance boots serialize on the lock, so migrations never run twice at once.
CMD ["sh", "-c", "MIGRATE_ONLY=1 node server.js && exec node server.js"]
