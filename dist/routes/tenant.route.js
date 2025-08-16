import express from "express";
import { createTenant, generateApiKey, listApiKeys, revokeApiKey, } from "../controllers/tenant.controller.js";
import { safeController } from "../middlewares/request-lock.middleware.js";
const router = express.Router();
router.post("/", safeController(createTenant));
router.post("/:tenantId/api-key", safeController(generateApiKey));
router.get("/:tenantId", safeController(listApiKeys));
router.delete("/:tenantId/keys/:keyId", safeController(revokeApiKey));
export default router;
