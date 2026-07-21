import type { Response } from "express";

export function sendResponse(
    res: Response,
    status: number,
    data: unknown = null,
    message = "success",
    meta?: unknown
) {
    res.status(status).json({
        status,
        message,
        data,
        ...(meta === undefined ? {} : { meta }),
    });
}
