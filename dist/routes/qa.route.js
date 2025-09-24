import express from "express";
import { getQAContent, submitQAResponse } from "../controllers/qa.controller.js";
import { singletonController } from "../utils/singleton-controller.js";
const router = express.Router();
router.get("/:agendaId", singletonController('getQAContent', getQAContent));
router.post("/:agendaId", singletonController('submitQAResponse', submitQAResponse));
export default router;
