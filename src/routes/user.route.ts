import express from "express";
import { 
  createUser, 
  getUser, 
  updateUser, 
  listUsers, 
  deleteUser 
} from "../controllers/user.controller.js";
import { safeController } from "../middlewares/request-lock.middleware.js";

const router = express.Router();

router.post("/", safeController(createUser));
router.get("/", safeController(listUsers));
router.get("/:userWallet", safeController(getUser));
router.put("/:userId", safeController(updateUser));
router.delete("/:userId", safeController(deleteUser));

export default router;