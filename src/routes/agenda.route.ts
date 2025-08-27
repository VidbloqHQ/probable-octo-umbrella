import express from "express";
import { singletonController } from "../utils/singleton-controller.js";
import {
  // createAgenda,
  // getStreamAgenda,
  updateStreamAgenda,
  deleteAgenda,
  getAgenda,
  getAgendaDetails,
  // getAgendaById
} from "../controllers/agenda.controller.js";
import { getAgendaById, createAgenda, getStreamAgenda } from "../controllers/new-agenda.js";

const router = express.Router();

router.post("/:streamId", singletonController('createAgenda', createAgenda));
router.get("/stream/:streamId", singletonController('getStreamAgenda', getStreamAgenda));
router.put("/:agendaId", singletonController('updateStreamAgenda', updateStreamAgenda));
router.get("/:agendaId", singletonController('getAgendaById', getAgendaById));
router.delete("/:agendaId/:wallet", singletonController('deleteAgenda', deleteAgenda));

export default router;
