import express from "express";
import { createTransaction, submitTransaction } from "../controllers/payment.controller.js";
const router = express.Router();
router.post("/", createTransaction);
router.post("/submit", submitTransaction);
export default router;
