import express from "express";
import {
  submitPollVote,
  getPollResults,
  getUserPollVote
} from "../controllers/poll.controller.js";
import { safeController } from "../middlewares/request-lock.middleware.js";

const router = express.Router();

router.post("/", safeController(submitPollVote));
router.get("/:agendaId", safeController(getPollResults));
router.get("/:agendaId/user-vote", safeController(getUserPollVote));

export default router;
