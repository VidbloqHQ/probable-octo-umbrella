import express from "express";
import {
  createTenant,
  generateApiKey,
  listApiKeys,
  revokeApiKey,
} from "../controllers/tenant.controller.js";
// import { safeController } from "../middlewares/request-lock.middleware.js";
import { singletonController } from "../utils/singleton-controller.js";

const router = express.Router();

router.post("/", singletonController('createTenant', createTenant));
router.post("/:tenantId/api-key", singletonController('generateApiKey', generateApiKey));
router.get("/:tenantId", singletonController('listApiKeys', listApiKeys));
router.delete("/:tenantId/keys/:keyId", singletonController('revokeApiKey', revokeApiKey));

export default router;
