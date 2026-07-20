import { Router } from "express";
import healthRouter from "./api/health/health.router.js";

const router = Router();

router.use("/health", healthRouter);

export default router;
