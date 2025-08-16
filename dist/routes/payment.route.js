import express from "express";
import { createTransaction, submitTransaction } from "../controllers/payment.controller.js";
import { safeController } from "../middlewares/request-lock.middleware.js";
const router = express.Router();
router.post("/", safeController(createTransaction));
router.post("/submit", safeController(submitTransaction));
export default router;
