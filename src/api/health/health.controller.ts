import type { Request, Response } from "express";
import { isDbHealthy } from "../../database.js";

export async function healthCheckHandler(_req: Request, res: Response) {
    const dbHealthy = await isDbHealthy();

    if (!dbHealthy) {
        res.status(503).json({
            status: "degraded",
            uptime: process.uptime(),
            timestamp: new Date(),
            services: { db: "disconnected" },
        });
        return;
    }

    res.status(200).json({
        status: "healthy",
        uptime: process.uptime(),
        timestamp: new Date(),
        services: { db: "connected" },
    });
}
