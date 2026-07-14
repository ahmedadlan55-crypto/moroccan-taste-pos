FROM node:18-alpine
WORKDIR /app

# 1) Backend production dependencies.
COPY package*.json ./
RUN npm install --production

# 2) Application source (frontend/*/dist is gitignored, so it is NEVER copied
#    here — each bundle is built fresh in the next steps).
COPY . .

# Closure Sprint v2 — the standalone Warehouse (/warehouse) and Order-to-Cash
# (/sales) SPAs are RETIRED: their features live in the unified ERP (/app), and
# server.js 302-redirects the old paths there. The image therefore builds exactly
# TWO React bundles: the unified Back-Office (/app) and the Cashier V2 POS (/pos-v2).

# 3) Build the Cashier V2 React SPA (served at /pos-v2 behind POS_V2_ENABLED; the
#    legacy /pos PWA remains the rollback path).
RUN npm run build:pos \
 && rm -rf frontend/pos/node_modules

# 4) Build the unified ADLAN Back-Office React SPA (served at /app behind
#    ERP_UNIFIED_ENABLED). The bundle ships in the image; when the flag is off
#    /app returns a 503 notice and the SPA is never mounted, so building it now
#    has no runtime effect until the flag is enabled.
RUN npm run build:erp \
 && rm -rf frontend/erp/node_modules

EXPOSE 3000
CMD ["node", "server.js"]
