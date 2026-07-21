import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApiRateLimiter } from "./rateLimitMiddleware.js";

describe("rate limit middleware", () => {
    it("returns the API error contract after the per-IP limit is exceeded", async () => {
        const app = express();
        app.use(createApiRateLimiter(60_000, 1));
        app.get("/resource", (_req, res) => res.status(200).json({ status: 200 }));

        const first = await request(app).get("/resource");
        const limited = await request(app).get("/resource");

        expect(first.status).toBe(200);
        expect(limited.status).toBe(429);
        expect(limited.body).toEqual({
            status: 429,
            code: "RateLimitExceeded",
            message: "Too many requests",
        });
        expect(limited.headers["ratelimit-limit"]).toBe("1");
    });
});
