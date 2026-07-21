import { describe, expect, it } from "vitest";
import { environmentSchema } from "./config.js";

const databaseUrl = "postgres://example";

describe("environment configuration", () => {
    it("does not trust forwarded proxy headers by default", () => {
        const config = environmentSchema.parse({ DATABASE_URL: databaseUrl });

        expect(config.TRUST_PROXY_HOPS).toBe(0);
    });

    it("requires rate limiting in production", () => {
        const missingRateLimit = environmentSchema.safeParse({
            NODE_ENV: "production",
            DATABASE_URL: databaseUrl,
        });
        const configured = environmentSchema.safeParse({
            NODE_ENV: "production",
            DATABASE_URL: databaseUrl,
            RATE_LIMIT_WINDOW_MINUTES: "1",
            RATE_LIMIT_MAX: "60",
        });

        expect(missingRateLimit.success).toBe(false);
        expect(configured.success).toBe(true);
    });
});
