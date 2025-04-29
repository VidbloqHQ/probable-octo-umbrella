import express from "express";
import { createTenant, generateApiKey, listApiKeys, revokeApiKey, } from "../controllers/tenant.controller.js";
const router = express.Router();
router.post("/", createTenant);
router.post("/:tenantId/api-key", generateApiKey);
router.get("/:tenantId", listApiKeys);
router.delete("/:tenantId/keys/:keyId", revokeApiKey);
export default router;
