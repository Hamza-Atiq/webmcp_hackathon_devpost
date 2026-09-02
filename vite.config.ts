/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    /**
     * The engine tests simulate real time, not mocked time. The speed-independence test
     * alone replays four minutes of a 450 rps environment at five different tick batch
     * sizes, which is minutes of honest computation rather than a hang. Vitest's 5-second
     * default reported those as failures when they were still running correctly.
     */
    testTimeout: 120_000,
  },
});
