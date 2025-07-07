import express from "express";
import {
  createAgenda,
  getStreamAgenda,
  updateStreamAgenda,
  deleteAgenda,
  getAgenda,
} from "../controllers/agenda.controller.js";

const router = express.Router();

router.post("/:streamId", createAgenda);
router.get("/:streamId", getStreamAgenda);
router.put("/:agendaId", updateStreamAgenda);
router.get("/:agendaId", getAgenda);
router.delete("/:agendaId/:wallet", deleteAgenda);

export default router;
