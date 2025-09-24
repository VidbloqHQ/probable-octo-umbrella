import express from "express";
import {
  submitPollVote,
  getPollResults,
  getUserPollVote,
  getPollContent
} from "../controllers/poll.controller.js";
// import { safeController } from "../middlewares/request-lock.middleware.js";
import { singletonController } from "../utils/singleton-controller.js";

const router = express.Router();

router.post("/", singletonController('submitPollVote', submitPollVote));
router.get("/:agendaId", singletonController('getPollContent', getPollContent)); // New endpoint
router.get("/:agendaId/results", singletonController('getPollResults', getPollResults));
router.get("/:agendaId/user-vote", singletonController('getUserPollVote', getUserPollVote));

export default router;
