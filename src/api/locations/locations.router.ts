import { Router } from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { validateQuery } from "../../middleware/validationMiddleware.js";
import { NODE_ENV, SEARCH_RATE_LIMIT_MAX, SEARCH_RATE_LIMIT_WINDOW_SECONDS } from "../../config.js";
import { reverseQuerySchema, searchQuerySchema } from "./locations.validation.js";
import { reverseLocationsHandler, searchLocationsHandler } from "./locations.controller.js";

const router = Router();

const searchRateLimiter =
    NODE_ENV !== "test" && SEARCH_RATE_LIMIT_WINDOW_SECONDS && SEARCH_RATE_LIMIT_MAX
        ? rateLimit({
              windowMs: SEARCH_RATE_LIMIT_WINDOW_SECONDS * 1000,
              limit: SEARCH_RATE_LIMIT_MAX,
              standardHeaders: true,
              legacyHeaders: false,
          })
        : (_req: unknown, _res: unknown, next: () => void) => next();

router.get(
    "/search",
    searchRateLimiter,
    validateQuery(searchQuerySchema),
    asyncHandler(searchLocationsHandler)
);

router.get("/reverse", validateQuery(reverseQuerySchema), asyncHandler(reverseLocationsHandler));

export default router;
