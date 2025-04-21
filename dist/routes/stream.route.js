import express from "express";
import { createStream, createStreamToken, getStream, recordStream, updateStream, } from "../controllers/stream.controller.js";
const router = express.Router();
router.post("/", createStream);
router.post("/token", createStreamToken);
router.get("/:streamId", getStream);
router.post("/record", recordStream);
router.put("/:streamId", updateStream);
export default router;
