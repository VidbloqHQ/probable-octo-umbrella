import express from "express";
import { createTransaction, submitTransaction } from "../controllers/payment.controller.js";
// import { safeController } from "../middlewares/request-lock.middleware.js";
import { singletonController } from "../utils/singleton-controller.js";

const router = express.Router()

router.post("/", singletonController('createTransaction', createTransaction))
router.post("/submit", singletonController('submitTransaction', submitTransaction))

export default router