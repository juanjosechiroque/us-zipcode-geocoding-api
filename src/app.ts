import express from "express";
import { pinoHttp } from "pino-http";
import cors from "cors";
import helmet from "helmet";
import type { Request } from "express";
import router from "./router.js";
import { errorGenericHandler } from "./middleware/errorMiddleware.js";
import { notFound } from "./middleware/notFoundMiddleware.js";
import { requestIdMiddleware } from "./middleware/requestIdMiddleware.js";
import { CORS_ALLOWED_ORIGINS, NODE_ENV, TRUST_PROXY_HOPS } from "./config.js";
import logger from "./utils/logger.js";

type RequestLogLevel = "silent" | "info" | "warn" | "error";

export function requestLogLevel(
    req: { originalUrl?: string; url?: string },
    res: { statusCode: number },
    error?: Error
): RequestLogLevel {
    const path = (req.originalUrl ?? req.url)?.split("?", 1)[0];

    if (!error && res.statusCode < 400 && path === "/v1/health") return "silent";
    if (error || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
}

const app = express();

app.set("trust proxy", TRUST_PROXY_HOPS);

app.use(helmet());
app.use(requestIdMiddleware);

if (NODE_ENV !== "test") {
    app.use(
        pinoHttp({
            logger,
            genReqId: (req: Request) => req.id,
            customLogLevel: requestLogLevel,
            customSuccessMessage: () => "request completed",
            customErrorMessage: () => "request failed",
            serializers: {
                req: (req: Record<string, unknown> & { query?: unknown }) => ({
                    id: req["id"],
                    method: req["method"],
                    url: req["url"],
                    query: req.query,
                }),
                res: (res: Record<string, unknown>) => ({ statusCode: res["statusCode"] }),
            },
        })
    );
}

if (CORS_ALLOWED_ORIGINS) {
    const allowedOrigins = CORS_ALLOWED_ORIGINS.split(",").map((origin) => origin.trim());

    app.use(
        cors({
            origin: allowedOrigins.includes("*") ? "*" : allowedOrigins,
        })
    );
}

app.use(express.json({ limit: "10kb" }));

app.get("/", (_req, res) => {
    res.json({ status: "running" });
});

app.use("/v1", router);
app.use(notFound);
app.use(errorGenericHandler);

export default app;
