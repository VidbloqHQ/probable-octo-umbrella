import { Request as ExpressRequest } from "express";
import { Tenant } from "@prisma/client";

export interface TenantRequest extends ExpressRequest {
  tenant?: Tenant;
}
