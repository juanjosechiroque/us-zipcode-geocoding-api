import { describe, expect, it } from "vitest";

const { api } = await import("./tests/helpers.js");
const { default: app } = await import("./app.js");

describe("GET /", () => {
    it("returns a running status", async () => {
        const response = await api.get("/");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: "running" });
    });
});

describe("proxy configuration", () => {
    it("does not trust X-Forwarded-* headers by default", () => {
        expect(app.get("trust proxy")).toBe(0);
    });
});
