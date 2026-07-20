import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodError, ZodType } from "zod";
import { BadRequestError } from "../errors.js";

function buildValidationError(zodError: ZodError) {
    const err = BadRequestError("Validation failed");
    err.details = zodError.issues.map((issue) => ({
        field: issue.path.join("."),
        error: issue.message,
    }));
    return err;
}

export function validateQuery(schema: ZodType): RequestHandler {
    return (req: Request, _res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.query);
        if (!result.success) return next(buildValidationError(result.error));
        req.validatedQuery = result.data;
        next();
    };
}
