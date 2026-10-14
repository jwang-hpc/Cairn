// Vite builds only the renderer (option A, M8): main and preload are compiled by tsc (tsconfig.main.json).
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../dist/renderer", emptyOutDir: true, target: "chrome140" },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
