import express from "express";
import {
  createStream,
  createStreamToken,
  getStream,
  recordStream,
  stopYoutubeStream,
  streamToYoutube,
  updateStream,
  stopStreamRecord,
} from "../controllers/stream.controller.js";

const router = express.Router();

router.post("/", createStream);
router.post("/token", createStreamToken);
router.get("/:streamId", getStream);
router.post("/record", recordStream);
router.post("/record/stop", stopStreamRecord);
router.put("/:streamId", updateStream);
router.post("/youtube", streamToYoutube);
router.post("/youtube/stop", stopYoutubeStream);

export default router;