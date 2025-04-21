import express from "express";

import {
  submitPollVote,
  getPollResults,
  getUserPollVote
} from "../controllers/poll.controller.js";

const router = express.Router();

router.post("/", submitPollVote);
router.get("/:agendaId", getPollResults);
router.get("/:agendaId", getUserPollVote);

export default router;
