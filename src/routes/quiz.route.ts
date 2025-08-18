import express from "express";

import { submitQuizAnswers, getQuizQuestions, getQuizResults, getUserQuizAnswers } from "../controllers/quiz.controller.js";
// import { safeController } from "../middlewares/request-lock.middleware.js";
import { singletonController } from "../utils/singleton-controller.js";

const router = express.Router();

router.post("/:agendaId", singletonController('submitQuizAnswers', submitQuizAnswers));
router.get("/:agendaId", singletonController('getQuizQuestions', getQuizQuestions));
router.get("/results/:agendaId", singletonController('getQuizResults', getQuizResults));
router.get("/answers/:agendaId", singletonController('getUserQuizAnswers', getUserQuizAnswers));

export default router;