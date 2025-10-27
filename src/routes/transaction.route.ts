import express from "express";
import { 
  createTransaction, 
  submitTransaction,
  getUserTransactionHistory,
  getStreamTransactionHistory,
  getTransactionStatus
} from "../controllers/transaction.controller.js";
import { singletonController } from "../utils/singleton-controller.js";
// import { submitTransaction, createTransaction } from "../controllers/new-transaction.js";

const router = express.Router();

// Transaction creation and submission
router.post("/create", singletonController('createTransaction', createTransaction));
router.post("/submit", 
  (req, res, next) => {
    (req as any).customTimeout = 45000; // 45 seconds for this endpoint only
    next();
  },
  singletonController('submitTransaction', submitTransaction)
);

// Transaction status endpoint - FIXED
router.get("/status/:signature", getTransactionStatus);

// Transaction history endpoints (don't need singleton as they're read-only)
router.get("/user/:userWallet", getUserTransactionHistory);
router.get("/stream/:streamId", getStreamTransactionHistory);

export default router;



// // Transaction creation and submission
// router.post("/create", singletonController('createTransaction', createTransaction));
// router.post("/submit", 
//   (req, res, next) => {
//     (req as any).customTimeout = 45000; // 45 seconds for this endpoint only
//     next();
//   },
//   singletonController('submitTransaction', submitTransaction)
// );

// // Transaction history endpoints (don't need singleton as they're read-only)
// router.get("/user/:userId", getUserTransactionHistory);
// router.get("/stream/:streamId", getStreamTransactionHistory);
// // Add this to your transaction routes
// router.get('/transaction/status/:signature', getTransactionStatus);

// // Keep legacy routes for backward compatibility (optional)
// // router.post("/", singletonController('createTransaction', createTransaction));

// export default router;

// # Pull the current database state to verify everything matches
// npx prisma db pull

// # Generate the Prisma client with the new fields
// npx prisma generate