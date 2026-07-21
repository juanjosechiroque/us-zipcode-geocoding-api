import { describe, expect, it } from "vitest";

const { api } = await import("./tests/helpers.js");
const { default: app, requestLogLevel } = await import("./app.js");

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

describe("request log level", () => {
    it("silences successful health checks", () => {
        expect(
            requestLogLevel({ originalUrl: "/v1/health", url: "/health" }, { statusCode: 200 })
        ).toBe("silent");
    });

    it("keeps degraded health checks visible", () => {
        expect(requestLogLevel({ url: "/v1/health" }, { statusCode: 503 })).toBe("error");
    });

    it("keeps successful API requests visible", () => {
        expect(requestLogLevel({ url: "/v1/locations/search" }, { statusCode: 200 })).toBe("info");
    });
});
