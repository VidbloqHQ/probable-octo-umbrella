import { Request, Response } from "express";
import { db } from "../prisma.js";
import { generateApiKeyData, isValidWalletAddress } from "../utils/index.js";

/**
 * Controller for creating a new tenant
 */
export const createTenant = async (req: Request, res: Response) => {
  // There should be a separate endpoint to update a tenant info - name, subdomain, themes/color and template
  try {
    const { creatorWallet } = req.body;

    if (!creatorWallet || typeof creatorWallet !== "string") {
      return res.status(400).json({
        error: "Missing required field: wallet address is required",
      });
    }
    if (!isValidWalletAddress(creatorWallet)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    // Create the tenant
    const tenant = await db.tenant.create({
      data: {
        creatorWallet,
      },
    });

    // Generate API key data
    const apiKeyData = await generateApiKeyData("Default API Key");

    // Create the API key in the database
    const apiKey = await db.apiToken.create({
      data: {
        key: apiKeyData.key,
        secret: apiKeyData.hashedSecret,
        name: apiKeyData.name,
        tenantId: tenant.id,
        expiresAt: apiKeyData.expiresAt,
      },
    });

    return res.status(201).json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        createdAt: tenant.createdAt,
      },
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        key: apiKey.key,
        secret: apiKeyData.rawSecret, // Only sent once during creation
        createdAt: apiKey.createdAt,
        expiresAt: apiKey.expiresAt,
      },
    });
  } catch (error) {
    console.error("Error creating tenant:", error);
    return res.status(500).json({ error: "Failed to create tenant" });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * Controller for generating new API keys for an existing tenant
 */
export const generateApiKey = async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    const { name, expiryDays } = req.body;

    if (!name) {
      return res.status(400).json({ error: "API key name is required" });
    }

    // Verify tenant exists
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    // Generate API key data
    const apiKeyData = await generateApiKeyData(name, expiryDays);

    // Create the API key in the database
    const apiKey = await db.apiToken.create({
      data: {
        key: apiKeyData.key,
        secret: apiKeyData.hashedSecret,
        name: apiKeyData.name,
        tenantId,
        expiresAt: apiKeyData.expiresAt,
      },
    });

    return res.status(201).json({
      id: apiKey.id,
      name: apiKey.name,
      key: apiKey.key,
      secret: apiKeyData.rawSecret, // Only returned once
      createdAt: apiKey.createdAt,
      expiresAt: apiKey.expiresAt,
    });
  } catch (error) {
    console.error("Error generating API key:", error);
    return res.status(500).json({ error: "Failed to generate API key" });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * Controller for listing a tenant's API keys
 */
export const listApiKeys = async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;

    // Verify tenant exists
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    // Fetch API keys (without exposing secrets)
    const apiKeys = await db.apiToken.findMany({
      where: { tenantId },
      select: {
        id: true,
        key: true,
        name: true,
        createdAt: true,
        expiresAt: true,
        lastUsedAt: true,
        isActive: true,
      },
    });

    return res.status(200).json(apiKeys);
  } catch (error) {
    console.error("Error listing API keys:", error);
    return res.status(500).json({ error: "Failed to list API keys" });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * Controller for revoking (deactivating) an API key
 */
export const revokeApiKey = async (req: Request, res: Response) => {
  try {
    const { tenantId, keyId } = req.params;

    // Check if API key exists and belongs to the tenant
    const apiKey = await db.apiToken.findFirst({
      where: {
        id: keyId,
        tenantId,
      },
    });

    if (!apiKey) {
      return res.status(404).json({ error: "API key not found" });
    }

    // Deactivate the key
    await db.apiToken.update({
      where: { id: keyId },
      data: { isActive: false },
    });

    return res.status(200).json({ message: "API key revoked successfully" });
  } catch (error) {
    console.error("Error revoking API key:", error);
    return res.status(500).json({ error: "Failed to revoke API key" });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};
