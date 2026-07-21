import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { requestIdMiddleware } from "./requestIdMiddleware.js";

function buildReq(headerValue: string | string[] | undefined): Request {
    return { headers: { "x-request-id": headerValue } } as unknown as Request;
}

function buildRes() {
    return { setHeader: vi.fn() } as unknown as Response;
}

describe("requestIdMiddleware", () => {
    it("uses the client-supplied x-request-id when it's a single string", () => {
        const req = buildReq("client-supplied-id");
        const res = buildRes();
        const next = vi.fn();

        requestIdMiddleware(req, res, next);

        expect(req.id).toBe("client-supplied-id");
        expect(res.setHeader).toHaveBeenCalledWith("x-request-id", "client-supplied-id");
        expect(next).toHaveBeenCalledOnce();
    });

    it("uses the first value when the header arrives as an array (duplicated header)", () => {
        const req = buildReq(["first-id", "second-id"]);
        const res = buildRes();
        const next = vi.fn();

        requestIdMiddleware(req, res, next);

        expect(req.id).toBe("first-id");
        expect(res.setHeader).toHaveBeenCalledWith("x-request-id", "first-id");
        expect(next).toHaveBeenCalledOnce();
    });

    it("accepts a safe request id at the maximum length", () => {
        const requestId = "a".repeat(128);
        const req = buildReq(requestId);
        const res = buildRes();

        requestIdMiddleware(req, res, vi.fn());

        expect(req.id).toBe(requestId);
    });

    it.each(["a".repeat(129), "unsafe request id", "line\nbreak"])(
        "replaces an unsafe request id with a UUID",
        (requestId) => {
            const req = buildReq(requestId);
            const res = buildRes();

            requestIdMiddleware(req, res, vi.fn());

            expect(req.id).not.toBe(requestId);
            expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
            expect(res.setHeader).toHaveBeenCalledWith("x-request-id", req.id);
        }
    );
});
