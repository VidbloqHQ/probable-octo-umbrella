import express from "express";
import {
  getTenantInfo,
  updateTenant,
  getAuthorizedDomains,
  addAuthorizedDomain,
  bulkAddAuthorizedDomains,
  removeAuthorizedDomain,
} from "../controllers/tenant-me.controller.js";
// import { safeController } from "../middlewares/request-lock.middleware.js";
import { singletonController } from "../utils/singleton-controller.js";
import { registerWebhook, removeWebhook } from "../controllers/webhook.controller.js";

const router = express.Router();

router.put("/", singletonController('updateTenant', updateTenant));
router.get("/info", singletonController('getTenantInfo', getTenantInfo));

router.put("/webhook", registerWebhook);
router.delete("/webhook", removeWebhook);

router.get("/authorized-domains", singletonController('getAuthorizedDomains', getAuthorizedDomains));
router.post("/authorized-domains", singletonController('addAuthorizedDomain', addAuthorizedDomain));
router.delete("/authorized-domains/:domainId", singletonController('removeAuthorizedDomain', removeAuthorizedDomain));
router.post("/authorized-domains/bulk", singletonController('bulkAddAuthorizedDomains', bulkAddAuthorizedDomains));

export default router;