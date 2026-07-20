import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import * as database from "../../database.js";
import { healthCheckHandler } from "./health.controller.js";

vi.mock("../../database.js", () => ({
    isDbHealthy: vi.fn(),
}));

function buildRes(): Response {
    const res = { status: vi.fn(), json: vi.fn() } as unknown as Response;
    vi.mocked(res.status).mockReturnValue(res);
    return res;
}

describe("healthCheckHandler", () => {
    it("returns 503 degraded when the DB is unreachable", async () => {
        vi.mocked(database.isDbHealthy).mockResolvedValueOnce(false);
        const res = buildRes();

        await healthCheckHandler({} as Request, res);

        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ status: "degraded", services: { db: "disconnected" } })
        );
    });
});
