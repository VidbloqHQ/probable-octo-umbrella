import express from "express";
import {
  getStreamParticipants,
  updateParticipantLeftTime,
  updateParticipantPermissions,
  getParticipantScores
} from "../controllers/participant.controller.js";

const router = express.Router();
router.get("/:streamId", getStreamParticipants);
router.put("/:streamId", updateParticipantLeftTime);
router.post("/update-permission", updateParticipantPermissions);
router.get("/scores", getParticipantScores);

export default router;
