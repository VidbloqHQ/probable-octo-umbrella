import express from "express";
import { 
  getWalletBalance,
  getBatchBalances,
  refreshWalletBalance
} from "../controllers/balance.controller.js";

const router = express.Router();

// Primary endpoints for SDK users (using wallet addresses)
router.get("/:walletAddress", getWalletBalance);
router.post("/:walletAddress/refresh", refreshWalletBalance);
router.post("/batch", getBatchBalances);

export default router;