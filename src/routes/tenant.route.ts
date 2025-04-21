import express from "express";
import {
  createTenant,
  generateApiKey,
  listApiKeys,
  revokeApiKey,
  updateTenant,
} from "../controllers/tenant.controller.js";
import { authenticateTenant } from "../middlewares/tenant-auth.middleware.js";


const publicTenantRouter = express.Router();
const protectedTenantRouter = express.Router();

publicTenantRouter.post("/", createTenant);
publicTenantRouter.post("/:tenantId/api-key", generateApiKey);
publicTenantRouter.get("/:tenantId", listApiKeys);
publicTenantRouter.delete("/:tenantId/keys/:keyId", revokeApiKey);

protectedTenantRouter.use(authenticateTenant);
protectedTenantRouter.put("/", updateTenant);

export default {
  publicRoutes: publicTenantRouter,
  protectedRoutes: protectedTenantRouter
};
