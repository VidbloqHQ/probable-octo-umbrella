import express from "express";
import {
  createStream,
  createStreamToken,
  getStream,
  recordStream,
  // stopYoutubeStream,
  // streamToYoutube,
  updateStream,
  // stopStreamRecord,
} from "../controllers/stream.controller.js";
// import { safeController } from "../middlewares/request-lock.middleware.js";
import { singletonController } from "../utils/singleton-controller.js";
// import { authenticateTenant } from "../middlewares/tenant-auth.middleware.js";
// import { createStream, getStream, createStreamToken } from "../controllers/new-stream.js";
// import { recordStream, stopStreamRecord, createRecordingBotToken, uploadRecording } from "../controllers/new-stream.js"
import { streamToYoutube, stopYoutubeStream, streamToFacebook, stopFacebookStream } from "../controllers/new-stream.js";

const router = express.Router();

router.post("/", singletonController('createStream', createStream));
router.post("/token", createStreamToken);
router.get("/:streamId", singletonController('getStream', getStream));
router.put("/:streamId", singletonController('updateStream', updateStream));
router.post("/record", singletonController('recordStream', recordStream));
// router.post("/record/stop", singletonController('stopStreamRecord', stopStreamRecord));

// router.post("/recording-bot-token", singletonController('createRecordingBotToken', createRecordingBotToken));
// router.post("/upload-recording", singletonController('uploadRecording', uploadRecording));

router.post("/youtube", singletonController('streamToYoutube', streamToYoutube));
router.post("/youtube/stop", singletonController('stopYoutubeStream', stopYoutubeStream));
router.post("/facebook", singletonController('streamToFacebook', streamToFacebook));
router.post("/facebook/stop", singletonController('stopFacebookStream', stopFacebookStream));

export default router;

// router.post("/token", singletonController('createStreamToken', createStreamToken));
// In your routes file, add a flag to skip certain middleware for token generation
// router.post("/token", 
//   authenticateTenant, // Keep this
//   // Skip: cacheMiddleware - tokens shouldn't be cached
//   // Skip: requestLockMiddleware - not needed for token generation
//   createStreamToken
// );