import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Never let a test touch the real home directory (~/.roundhouse etc.).
    globalSetup: ["./test/setup/global-home.ts"],
    setupFiles: ["./test/setup/isolate-home.ts"],
  },
});
