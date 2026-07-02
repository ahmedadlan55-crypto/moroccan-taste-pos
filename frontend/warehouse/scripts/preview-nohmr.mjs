// Dev server with HMR disabled — used only for headless screenshot capture,
// whose "network idle" wait never settles while Vite's HMR WebSocket is open.
// Normal development uses `npm run dev` (HMR on).
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

process.env.VITE_NO_HMR = "1";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.ts"),
});
await server.listen();
server.printUrls();
