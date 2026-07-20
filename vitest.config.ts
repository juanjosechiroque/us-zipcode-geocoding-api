import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        globals: false,
        include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
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
                "index.ts",
                "src/**/*.d.ts",
            ],
        },
    },
});
