import express from "express";
import { createTransaction, submitTransaction } from "../controllers/payment.controller.js";
// import { safeController } from "../middlewares/request-lock.middleware.js";
import { singletonController } from "../utils/singleton-controller.js";
const router = express.Router();
router.post("/", singletonController('createTransaction', createTransaction));
// router.post("/submit", singletonController('submitTransaction', submitTransaction))
router.post("/submit", (req, res, next) => {
    req.customTimeout = 45000; // 45 seconds for this endpoint only
    next();
}, singletonController('submitTransaction', submitTransaction));
export default router;
