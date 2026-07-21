import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { validateQuery } from "../../middleware/validationMiddleware.js";
import { NODE_ENV, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MINUTES } from "../../config.js";
import { createApiRateLimiter } from "../../middleware/rateLimitMiddleware.js";
import {
    radiusQuerySchema,
    reverseQuerySchema,
    searchQuerySchema,
} from "./locations.validation.js";
import {
    radiusLocationsHandler,
    reverseLocationsHandler,
    searchLocationsHandler,
} from "./locations.controller.js";

const router = Router();

if (NODE_ENV !== "test" && RATE_LIMIT_WINDOW_MINUTES && RATE_LIMIT_MAX) {
    router.use(createApiRateLimiter(RATE_LIMIT_WINDOW_MINUTES * 60 * 1000, RATE_LIMIT_MAX));
}

router.get("/search", validateQuery(searchQuerySchema), asyncHandler(searchLocationsHandler));

router.get("/reverse", validateQuery(reverseQuerySchema), asyncHandler(reverseLocationsHandler));

router.get("/radius", validateQuery(radiusQuerySchema), asyncHandler(radiusLocationsHandler));

export default router;
