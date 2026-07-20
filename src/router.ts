import { Router } from "express";
import healthRouter from "./api/health/health.router.js";
import locationsRouter from "./api/locations/locations.router.js";

const router = Router();

router.use("/health", healthRouter);
router.use("/locations", locationsRouter);

export default router;
