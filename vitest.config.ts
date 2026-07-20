import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        globals: false,
        include: ["src/**/*.test.ts"],
        clearMocks: true,
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov"],
            exclude: [
                "coverage/**",
                "dist/**",
                "scripts/**",
                "src/**/*.test.ts",
                "src/tests/**",
                "vitest.config.ts",
                "eslint.config.js",
                // Entry point (app.listen) is never imported by tests — that would bind a real port.
                "index.ts",
                // Ambient type-augmentation files are picked up by tsconfig, never imported at runtime.
                "src/**/*.d.ts",
            ],
        },
    },
});
