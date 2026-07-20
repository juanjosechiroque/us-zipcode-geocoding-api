import { z } from "zod";

if (process.env.NODE_ENV !== "production") {
    const dotenv = await import("dotenv");
    dotenv.config();
}

const envSchema = z
    .object({
        NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
        PORT: z.coerce.number().int().positive().default(3000),
        DATABASE_URL: z.string().trim().min(1, "DATABASE_URL is required"),
        CORS_ALLOWED_ORIGINS: z.string().trim().optional(),
        RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().optional(),
        RATE_LIMIT_MAX: z.coerce.number().int().positive().optional(),
        SEARCH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().optional(),
        SEARCH_RATE_LIMIT_MAX: z.coerce.number().int().positive().optional(),
        LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    })
    .refine(
        (env) =>
            (env.RATE_LIMIT_WINDOW_MINUTES == null && env.RATE_LIMIT_MAX == null) ||
            (env.RATE_LIMIT_WINDOW_MINUTES != null && env.RATE_LIMIT_MAX != null),
        {
            message: "RATE_LIMIT_WINDOW_MINUTES and RATE_LIMIT_MAX must be configured together",
            path: ["RATE_LIMIT_WINDOW_MINUTES"],
        }
    )
    .refine(
        (env) =>
            (env.SEARCH_RATE_LIMIT_WINDOW_SECONDS == null && env.SEARCH_RATE_LIMIT_MAX == null) ||
            (env.SEARCH_RATE_LIMIT_WINDOW_SECONDS != null && env.SEARCH_RATE_LIMIT_MAX != null),
        {
            message:
                "SEARCH_RATE_LIMIT_WINDOW_SECONDS and SEARCH_RATE_LIMIT_MAX must be configured together",
            path: ["SEARCH_RATE_LIMIT_WINDOW_SECONDS"],
        }
    );

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
    console.error("Invalid environment configuration");
    console.error(parsedEnv.error.flatten().fieldErrors);
    process.exit(1);
}

export const {
    NODE_ENV,
    PORT,
    DATABASE_URL,
    CORS_ALLOWED_ORIGINS,
    RATE_LIMIT_WINDOW_MINUTES,
    RATE_LIMIT_MAX,
    SEARCH_RATE_LIMIT_WINDOW_SECONDS,
    SEARCH_RATE_LIMIT_MAX,
    LOG_LEVEL,
} = parsedEnv.data;
