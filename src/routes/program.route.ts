import { Router } from "express";
import {
  getStreamPDAController,
  buildInitializeTransactionController,
  buildStartStreamTransactionController,
  buildCompleteStreamTransactionController,
  buildDepositTransactionController,
  buildDistributeTransactionController,
  buildRefundTransactionController,
  buildUpdateStreamTransactionController,
  recordTransactionController,
  getStreamController,
  listStreamsController,
  listDonationsController,
  listDistributionsController
} from "../controllers/program.controller.js";

const router = Router();

// Stream management endpoints
router.get("/stream-pda", getStreamPDAController);
router.post("/initialize", buildInitializeTransactionController);
router.post("/start-stream", buildStartStreamTransactionController);
router.post("/complete-stream", buildCompleteStreamTransactionController);
router.post("/deposit", buildDepositTransactionController);
router.post("/distribute", buildDistributeTransactionController);
router.post("/refund", buildRefundTransactionController);
router.post("/update-stream", buildUpdateStreamTransactionController);
router.post("/record-transaction", recordTransactionController);

// Query endpoints
router.get("/stream", getStreamController);
router.get("/streams", listStreamsController);
router.get("/donations", listDonationsController);
router.get("/distributions", listDistributionsController);

export default router;