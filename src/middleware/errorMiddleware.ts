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
    if (err == null || typeof err !== "object") {
        return { statusCode: 500, code: "InternalServerError", message: "Internal server error" };
    }

    const errorLike = err as Partial<AppError>;

    if (errorLike.statusCode) {
        return {
            statusCode: errorLike.statusCode,
            code: errorLike.code ?? "Error",
            message: errorLike.message ?? "Unexpected error",
            details: errorLike.details,
        };
    }

    const isProduction = NODE_ENV === "production";
    return {
        statusCode: 500,
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
        if (NODE_ENV === "production") {
            resolved.message = "Internal server error";
            resolved.code = "InternalServerError";
        }
    }

    const result: {
        status: number;
        code: string;
        message: string;
        details?: AppError["details"] | undefined;
    } = {
        status: resolved.statusCode,
        code: resolved.code,
        message: resolved.message,
    };

    if (resolved.details != null && Array.isArray(resolved.details)) {
        result.details = resolved.details;
    }

    res.status(resolved.statusCode).json(result);
};
