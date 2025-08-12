import express from "express";
import {
  getTenantInfo,
  updateTenant,
  getAuthorizedDomains,
  addAuthorizedDomain,
  bulkAddAuthorizedDomains,
  removeAuthorizedDomain
} from "../controllers/tenant-me.controller.js";

const router = express.Router();

router.put("/", updateTenant);
router.get("/info", getTenantInfo);

router.get("/authorized-domains", getAuthorizedDomains);
router.post("/authorized-domains", addAuthorizedDomain);
router.delete("/authorized-domains/:domainId", removeAuthorizedDomain);
router.post("/authorized-domains/bulk", bulkAddAuthorizedDomains);

export default router;