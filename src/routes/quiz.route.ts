import express from "express";

import { submitQuizAnswers, getQuizQuestions, getQuizResults, getUserQuizAnswers } from "../controllers/quiz.controller.js";
import { safeController } from "../middlewares/request-lock.middleware.js";

const router = express.Router();

router.post("/:agendaId", safeController(submitQuizAnswers));
router.get("/:agendaId", safeController(getQuizQuestions));
router.get("/results/:agendaId", safeController(getQuizResults));
router.get("/answers/:agendaId", safeController(getUserQuizAnswers));

export default router;