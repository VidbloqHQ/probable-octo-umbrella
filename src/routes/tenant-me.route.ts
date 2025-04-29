import express from "express";
import {
  getTenantInfo,
  updateTenant,
} from "../controllers/tenant-me.controller.js";

const router = express.Router();

router.put("/", updateTenant);
router.get("/info", getTenantInfo);

export default router;
