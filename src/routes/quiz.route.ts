import express from "express";

import { submitQuizAnswers, getQuizQuestions, getQuizResults, getUserQuizAnswers } from "../controllers/quiz.controller.js";

const router = express.Router();

router.post("/:agendaId", submitQuizAnswers);
router.get("/:agendaId", getQuizQuestions);
router.get("/results/:agendaId", getQuizResults);
router.get("/answers/:agendaId", getUserQuizAnswers);

export default router;