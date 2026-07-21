// Browser dev harness config: renders the real app in a plain browser by swapping the
// four @tauri-apps modules for src/dev/tauriMock.ts. Run with:
//   npx vite --config vite.harness.config.ts --port 5188
// Never used by the production build (npm run build uses vite.config.ts).
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";

const mock = fileURLToPath(new URL("./src/dev/tauriMock.ts", import.meta.url));
const publicDir = fileURLToPath(new URL("./public", import.meta.url));

/// publicDir is claimed by dev-assets (harness media), which hides the real public/ dir —
/// including public/wasm-pkg, where build:wasm puts the compositor (P3). Serve just that
/// subtree manually so the harness exercises the WebGPU path like every other mode.
function serveWasmPkg(): Plugin {
  const MIME: Record<string, string> = {
    ".js": "text/javascript",
    ".wasm": "application/wasm",
    ".ts": "text/plain",
  };
  return {
    name: "harness-serve-wasm-pkg",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (!url.startsWith("/wasm-pkg/") || url.includes("..")) return next();
        const file = join(publicDir, url);
        if (!existsSync(file)) return next();
        const ext = url.slice(url.lastIndexOf("."));
        res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveWasmPkg()],
  clearScreen: false,
  // Harness-only: serves renderly-app/dev-assets/*.mp4 (generated locally with ffmpeg,
  // gitignored) at the site root so tauriMock's convertFileSrc can point the sample
  // project's video media at real, browser-decodable files — see
  // docs/preview-webview.md "Harness verification". Never touches vite.config.ts /
  // the production build.
  publicDir: "dev-assets",
  resolve: {
    alias: [
      { find: "@tauri-apps/api/core", replacement: mock },
      { find: "@tauri-apps/api/event", replacement: mock },
      { find: "@tauri-apps/api/window", replacement: mock },
      { find: "@tauri-apps/plugin-dialog", replacement: mock },
    ],
  },
  server: { port: 5188, strictPort: true },
});
