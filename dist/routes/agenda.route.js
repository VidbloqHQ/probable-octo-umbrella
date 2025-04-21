import express from "express";
import { createAgenda, getStreamAgenda, updateStreamAgenda, deleteAgenda, } from "../controllers/agenda.controller.js";
const router = express.Router();
router.post("/:streamId", createAgenda);
router.get("/:streamId", getStreamAgenda);
router.put("/:agendaId", updateStreamAgenda);
router.delete("/:agendaId", deleteAgenda);
export default router;
