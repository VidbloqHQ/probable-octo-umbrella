import express from "express";
import { handleLivekitWebhook } from "../controllers/webhook.controller.js";
const router = express.Router();
// LiveKit sends webhooks with a signed JWT in the Authorization header.
// The body must be parsed as text for signature verification.
router.post("/livekit", express.text({ type: "application/webhook+json" }), express.text({ type: "application/json" }), handleLivekitWebhook);
export default router;
