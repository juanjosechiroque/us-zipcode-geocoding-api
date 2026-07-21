import rateLimit from "express-rate-limit";

export function createApiRateLimiter(windowMs: number, limit: number) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res) => {
            res.status(429).json({
                status: 429,
                code: "RateLimitExceeded",
                message: "Too many requests",
            });
        },
    });
}
