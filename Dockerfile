FROM node:18-alpine
WORKDIR /app

# 1) Backend production dependencies.
COPY package*.json ./
RUN npm install --production

# 2) Application source (frontend/warehouse/dist is gitignored, so it is NEVER
#    copied here — the bundle is built fresh in the next step).
COPY . .

# 3) Build the warehouse-v2 React SPA from source so Express can serve it at
#    /warehouse-v2. The build toolchain (dev deps) is installed, the bundle is
#    produced into frontend/warehouse/dist inside the image, then node_modules
#    for the frontend is dropped (the server serves the static dist, not the
#    toolchain). This runs BEFORE the container starts Express, and never
#    relies on a stale local dist.
RUN npm run build:warehouse \
 && rm -rf frontend/warehouse/node_modules

# 4) Build the Cashier V2 React SPA the same way (served at /pos-v2 behind
#    POS_V2_ENABLED; the legacy /pos PWA remains the rollback path).
RUN npm run build:pos \
 && rm -rf frontend/pos/node_modules

EXPOSE 3000
CMD ["node", "server.js"]
