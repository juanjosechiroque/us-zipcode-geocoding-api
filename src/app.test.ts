import { describe, expect, it } from "vitest";

const { api } = await import("./tests/helpers.js");

describe("GET /", () => {
    it("returns a running status", async () => {
        const response = await api.get("/");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: "running" });
    });
});
