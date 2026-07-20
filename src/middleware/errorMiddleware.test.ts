import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { errorGenericHandler } from "./errorMiddleware.js";

function buildReq(): Request {
    return { id: "test-request-id" } as unknown as Request;
}

function buildRes(): Response {
    const res = { status: vi.fn(), json: vi.fn() } as unknown as Response;
    vi.mocked(res.status).mockReturnValue(res);
    return res;
}

describe("errorGenericHandler", () => {
    afterEach(() => {
        vi.doUnmock("../config.js");
        vi.resetModules();
    });

    it("returns 500 with the real error message when not in production", () => {
        const res = buildRes();

        errorGenericHandler(new Error("boom"), buildReq(), res, vi.fn());

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ status: 500, code: "InternalServerError", message: "boom" })
        );
    });

    it("hides the real error message in production", async () => {
        vi.doMock("../config.js", async (importOriginal) => {
            const actual = await importOriginal<typeof import("../config.js")>();
            return { ...actual, NODE_ENV: "production" };
        });
        const { errorGenericHandler: prodHandler } = await import("./errorMiddleware.js");
        const res = buildRes();

        prodHandler(new Error("leaked db connection string"), buildReq(), res, vi.fn());

        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ status: 500, code: "InternalServerError" })
        );
        const body = vi.mocked(res.json).mock.calls[0]?.[0] as { message: string };
        expect(body.message).toBe("Internal server error");
        expect(body.message).not.toContain("leaked db connection string");
    });
});
