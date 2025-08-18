import express from "express";
import { submitPollVote, getPollResults, getUserPollVote } from "../controllers/poll.controller.js";
// import { safeController } from "../middlewares/request-lock.middleware.js";
import { singletonController } from "../utils/singleton-controller.js";
const router = express.Router();
router.post("/", singletonController('submitPollVote', submitPollVote));
router.get("/:agendaId", singletonController('getPollResults', getPollResults));
router.get("/:agendaId/user-vote", singletonController('getUserPollVote', getUserPollVote));
export default router;
