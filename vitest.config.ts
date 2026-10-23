import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/tests/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "services/*/tests/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**"],
    passWithNoTests: true,
    reporters: ["verbose"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
  },
});
