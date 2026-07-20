import { describe, expect, it } from "vitest";

const { api, V1 } = await import("../../tests/helpers.js");

describe("GET /health", () => {
    it("reports DB connectivity status (200 connected, 503 degraded)", async () => {
        const response = await api.get(`${V1}/health`);

        expect([200, 503]).toContain(response.status);
        expect(response.body).toHaveProperty("uptime");
        expect(response.body).toHaveProperty("services.db");
    });
});

describe("GET /unknown-route", () => {
    it("returns a consistent 404 error shape", async () => {
        const response = await api.get(`${V1}/nope`);

        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({ status: 404, code: "NotFoundError" });
    });
});
