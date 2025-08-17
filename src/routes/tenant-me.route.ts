import express from "express";
import {
  getTenantInfo,
  updateTenant,
  getAuthorizedDomains,
  addAuthorizedDomain,
  bulkAddAuthorizedDomains,
  removeAuthorizedDomain
} from "../controllers/tenant-me.controller.js";
import { safeController } from "../middlewares/request-lock.middleware.js";
import { singletonController } from "../utils/singleton-controller.js";

const router = express.Router();

router.put("/", safeController(singletonController('updateTenant', updateTenant)));
router.get("/info", safeController(singletonController('getTenantInfo', getTenantInfo)));

router.get("/authorized-domains", safeController(singletonController('getAuthorizedDomains', getAuthorizedDomains)));
router.post("/authorized-domains", safeController(singletonController('addAuthorizedDomain', addAuthorizedDomain)));
router.delete("/authorized-domains/:domainId", safeController(singletonController('removeAuthorizedDomain', removeAuthorizedDomain)));
router.post("/authorized-domains/bulk", safeController(singletonController('bulkAddAuthorizedDomains', bulkAddAuthorizedDomains)));

export default router;