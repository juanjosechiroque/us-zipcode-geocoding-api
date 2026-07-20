import { describe, expect, it } from "vitest";

const { api, V1 } = await import("../../tests/helpers.js");

describe("GET /health", () => {
    it("returns 200 with a healthy status", async () => {
        const response = await api.get(`${V1}/health`);

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ status: "healthy" });
        expect(response.body).toHaveProperty("uptime");
    });
});

describe("GET /unknown-route", () => {
    it("returns a consistent 404 error shape", async () => {
        const response = await api.get(`${V1}/nope`);

        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({ status: 404, code: "NotFoundError" });
    });
});
