import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard always connects to `/ws` on the origin that served it. In
// dev that origin is Vite, so set SQUAD_GATEWAY (an http origin, e.g.
// http://127.0.0.1:8092 for `pnpm mock`) to proxy the gateway's routes
// through the dev server. Unset, nothing is proxied.
const gateway = process.env.SQUAD_GATEWAY;

export default defineConfig({
  plugins: [react()],
  server: gateway
    ? {
        proxy: {
          "/ws": { target: gateway, ws: true },
          "/pair": { target: gateway },
          "/apps": { target: gateway, ws: true },
        },
      }
    : undefined,
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
