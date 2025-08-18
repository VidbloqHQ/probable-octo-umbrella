import express from "express";
import { getStreamParticipants, updateParticipantLeftTime, updateParticipantPermissions, getParticipantScores,
// handleWebSocketDisconnect
 } from "../controllers/participant.controller.js";
// import { safeController } from "../middlewares/request-lock.middleware.js";
import { singletonController } from "../utils/singleton-controller.js";
const router = express.Router();
router.get("/:streamId", singletonController('getStreamParticipants', getStreamParticipants));
router.put("/:streamId", singletonController('updateParticipantLeftTime', updateParticipantLeftTime));
router.post("/:streamId", singletonController('updateParticipantLeftTime', updateParticipantLeftTime));
router.post("/update/permission", singletonController('updateParticipantPermissions', updateParticipantPermissions));
router.get("/scores", singletonController('getParticipantScores', getParticipantScores));
export default router;
// router.get("/:streamId", getStreamParticipants);
// router.put("/:streamId", updateParticipantLeftTime);
// router.post("/:streamId", updateParticipantLeftTime);
// router.post("/update/permission", updateParticipantPermissions);
// // router.post('/:streamId/disconnect/:participantId', handleWebSocketDisconnect);
// router.get("/scores", getParticipantScores);
