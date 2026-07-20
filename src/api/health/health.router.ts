import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { healthCheckHandler } from "./health.controller.js";

const router = Router();

router.get("/", asyncHandler(healthCheckHandler));

export default router;
