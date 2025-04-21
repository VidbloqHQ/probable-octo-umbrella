import express from "express";
import { createLiveStream, createStreamToken, getLiveStream, recordLiveStream, updateLiveStream, } from "../controllers/livestream.controller.js";
const router = express.Router();
router.post("/", createLiveStream);
router.post("/token", createStreamToken);
router.get("/:liveStreamId", getLiveStream);
router.post("/record", recordLiveStream);
router.put("/:liveStreamId", updateLiveStream);
export default router;
