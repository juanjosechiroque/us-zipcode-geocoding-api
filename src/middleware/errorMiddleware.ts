import type { ErrorRequestHandler } from "express";
import type { AppError } from "../errors.js";
import { NODE_ENV } from "../config.js";
import logger from "../utils/logger.js";

type ResolvedError = {
    statusCode: number;
    code: string;
    message: string;
    details?: AppError["details"] | undefined;
};

function resolveError(err: unknown): ResolvedError {
    const errorLike = err != null && typeof err === "object" ? (err as Partial<AppError>) : {};
    const statusCode = errorLike.statusCode ?? 500;

    if (statusCode < 500) {
        return {
            statusCode,
            code: errorLike.code ?? "Error",
            message: errorLike.message ?? "Unexpected error",
            details: errorLike.details,
        };
    }

    const isProduction = NODE_ENV === "production";
    return {
        statusCode,
        code: "InternalServerError",
        message: isProduction
            ? "Internal server error"
            : (errorLike.message ?? "Internal server error"),
    };
}

export const errorGenericHandler: ErrorRequestHandler = (err, req, res, _next) => {
    const resolved = resolveError(err);

    if (resolved.statusCode >= 500) {
        logger.error({ err, requestId: req.id }, "Unhandled request error");
    }

    const body: { status: number; code: string; message: string; details?: AppError["details"] } = {
        status: resolved.statusCode,
        code: resolved.code,
        message: resolved.message,
    };

    if (resolved.details != null && Array.isArray(resolved.details)) {
        body.details = resolved.details;
    }

    res.status(resolved.statusCode).json(body);
};
