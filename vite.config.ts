import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] },
    // Dev-only demo mode (src/dev/mock.ts) previews fonts that ship with macOS.
    fs: { allow: [".", "/System/Library/Fonts"] },
  },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
