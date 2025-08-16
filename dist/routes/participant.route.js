import express from "express";
import { getStreamParticipants, updateParticipantLeftTime, updateParticipantPermissions, getParticipantScores,
// handleWebSocketDisconnect
 } from "../controllers/participant.controller.js";
import { safeController } from "../middlewares/request-lock.middleware.js";
const router = express.Router();
// router.get("/:streamId", getStreamParticipants);
// router.put("/:streamId", updateParticipantLeftTime);
// router.post("/:streamId", updateParticipantLeftTime);
// router.post("/update/permission", updateParticipantPermissions);
// // router.post('/:streamId/disconnect/:participantId', handleWebSocketDisconnect);
// router.get("/scores", getParticipantScores);
router.get("/:streamId", safeController(getStreamParticipants));
router.put("/:streamId", safeController(updateParticipantLeftTime));
router.post("/:streamId", safeController(updateParticipantLeftTime));
router.post("/update/permission", safeController(updateParticipantPermissions));
router.get("/scores", safeController(getParticipantScores));
export default router;
