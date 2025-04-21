import express from "express";
import { 
  createUser, 
  getUser, 
  updateUser, 
  listUsers, 
  deleteUser 
} from "../controllers/user.controller.js";

const router = express.Router();

router.post("/", createUser);
router.get("/", listUsers);
router.get("/:userWallet", getUser);
router.put("/:userId", updateUser);
router.delete("/:userId", deleteUser);

export default router;