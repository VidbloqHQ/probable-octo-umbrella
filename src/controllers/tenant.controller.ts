import { Request, Response } from "express";
import { StreamSessionType, StreamFundingType } from "@prisma/client";
import { db } from "../prisma.js";
import { generateApiKeyData, isValidWalletAddress } from "../utils/index.js";
import { TenantRequest } from "../types/index.js";

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
  } finally {
    await db.$disconnect();
  }
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
  } finally {
    await db.$disconnect();
  }
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
  } finally {
    await db.$disconnect();
  }
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
  } finally {
    await db.$disconnect();
  }
};

/**
 * Controller for updating tenant settings
 */
export const updateTenant = async (req: TenantRequest, res: Response) => {
  try {
    // Ensure tenant is authenticated via middleware
    if (!req.tenant || !req.tenant.id) {
      return res.status(401).json({ error: "Authenticated tenant required" });
    }
    
    const tenantId = req.tenant.id;
    
    // Extract updatable fields from request body
    const {
      name,
      theme,
      primaryColor,
      secondaryColor,
      logo,
      templateId,
      rpcEndpoint,
      networkCluster,
      defaultStreamType,
      defaultFundingType,
      enabledStreamTypes,
      authorizedDomains, // Array of domains to authorize
    } = req.body;
    
    // Prepare the data for update
    const updateData: any = {};
    
    // Only include fields that are provided
    if (name !== undefined) updateData.name = name;
    if (theme !== undefined) updateData.theme = theme;
    if (primaryColor !== undefined) updateData.primaryColor = primaryColor;
    if (secondaryColor !== undefined) updateData.secondaryColor = secondaryColor;
    if (logo !== undefined) updateData.logo = logo;
    if (templateId !== undefined) updateData.templateId = templateId;
    if (rpcEndpoint !== undefined) updateData.rpcEndpoint = rpcEndpoint;
    if (networkCluster !== undefined) updateData.networkCluster = networkCluster;
    
    // Validate and include the new stream-related fields
    if (defaultStreamType !== undefined) {
      if (!Object.values(StreamSessionType).includes(defaultStreamType)) {
        return res.status(400).json({
          error: "Invalid defaultStreamType",
          validOptions: Object.values(StreamSessionType)
        });
      }
      updateData.defaultStreamType = defaultStreamType;
    }
    
    if (defaultFundingType !== undefined) {
      if (!Object.values(StreamFundingType).includes(defaultFundingType)) {
        return res.status(400).json({
          error: "Invalid defaultFundingType",
          validOptions: Object.values(StreamFundingType)
        });
      }
      updateData.defaultFundingType = defaultFundingType;
    }
    
    // Start a transaction for the entire update
    await db.$transaction(async (tx) => {
      // Update tenant basic information
      const updatedTenant = await tx.tenant.update({
        where: { id: tenantId },
        data: updateData,
      });
      
      // Handle enabled stream types if provided
      if (enabledStreamTypes !== undefined) {
        // Check if the tenant already has enabledStreamTypes record
        const existingEnabledTypes = await tx.enabledStreamTypes.findUnique({
          where: { tenantId }
        });
        
        if (existingEnabledTypes) {
          // Update existing record
          await tx.enabledStreamTypes.update({
            where: { tenantId },
            data: {
              enableStream: enabledStreamTypes.enableStream ?? existingEnabledTypes.enableStream,
              enableMeeting: enabledStreamTypes.enableMeeting ?? existingEnabledTypes.enableMeeting,
              enablePodcast: enabledStreamTypes.enablePodcast ?? existingEnabledTypes.enablePodcast
            }
          });
        } else {
          // Create new record
          await tx.enabledStreamTypes.create({
            data: {
              tenantId,
              enableStream: enabledStreamTypes.enableStream ?? true,
              enableMeeting: enabledStreamTypes.enableMeeting ?? true,
              enablePodcast: enabledStreamTypes.enablePodcast ?? false
            }
          });
        }
      }
      
      // Handle authorized domains if provided
      if (authorizedDomains && Array.isArray(authorizedDomains)) {
        // First, get existing domains
        const existingDomains = await tx.authorizedDomain.findMany({
          where: { tenantId },
          select: { domain: true },
        });
        
        const existingDomainSet = new Set(existingDomains.map((d) => d.domain));
        const newDomainSet = new Set(authorizedDomains);
        
        // Domains to add (in new but not in existing)
        const domainsToAdd = authorizedDomains.filter(
          (domain) => !existingDomainSet.has(domain)
        );
        
        // Domains to remove (in existing but not in new)
        const domainsToRemove = [...existingDomainSet].filter(
          (domain) => !newDomainSet.has(domain)
        );
        
        // Add new domains
        if (domainsToAdd.length > 0) {
          await Promise.all(
            domainsToAdd.map(domain => 
              tx.authorizedDomain.create({
                data: {
                  domain,
                  tenantId,
                }
              })
            )
          );
        }
        
        // Remove old domains
        if (domainsToRemove.length > 0) {
          await tx.authorizedDomain.deleteMany({
            where: {
              tenantId,
              domain: { in: domainsToRemove },
            },
          });
        }
      }
    });
    
    // Fetch updated tenant with all related info
    const fullTenant = await db.tenant.findUnique({
      where: { id: tenantId },
      include: {
        authorizedDomains: {
          select: { domain: true },
        },
        enabledStreamTypes: true
      },
    });
    
    if (!fullTenant) {
      return res.status(404).json({ error: "Tenant not found" });
    }
    
    // Format the response
    return res.status(200).json({
      tenant: {
        id: fullTenant.id,
        name: fullTenant.name,
        theme: fullTenant.theme,
        primaryColor: fullTenant.primaryColor,
        secondaryColor: fullTenant.secondaryColor,
        logo: fullTenant.logo,
        templateId: fullTenant.templateId,
        rpcEndpoint: fullTenant.rpcEndpoint,
        networkCluster: fullTenant.networkCluster,
        creatorWallet: fullTenant.creatorWallet,
        createdAt: fullTenant.createdAt,
        updatedAt: fullTenant.updatedAt,
        defaultStreamType: fullTenant.defaultStreamType,
        defaultFundingType: fullTenant.defaultFundingType,
        enabledStreamTypes: fullTenant.enabledStreamTypes || {
          enableStream: true,
          enableMeeting: true,
          enablePodcast: false
        },
        authorizedDomains: fullTenant.authorizedDomains.map((d) => d.domain),
      },
    });
  } catch (error) {
    console.error("Error updating tenant:", error);
    return res.status(500).json({ error: "Failed to update tenant" });
  } finally {
    await db.$disconnect();
  }
};

/**
 * Controller for getting all tenant information
 */
export const getTenantInfo = async (req: TenantRequest, res: Response) => {
  try {
    // Ensure tenant is authenticated via middleware
    if (!req.tenant || !req.tenant.id) {
      return res.status(401).json({ error: "Authenticated tenant required" });
    }
    
    const tenantId = req.tenant.id;
    
    // Fetch tenant with all related info
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      include: {
        authorizedDomains: {
          select: { domain: true },
        },
        enabledStreamTypes: true
      },
    });
    
    if (!tenant) {
      return res.status(404).json({ error: "Tenant not found" });
    }
    
    // Format the response
    return res.status(200).json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        theme: tenant.theme,
        primaryColor: tenant.primaryColor,
        secondaryColor: tenant.secondaryColor,
        logo: tenant.logo,
        templateId: tenant.templateId,
        rpcEndpoint: tenant.rpcEndpoint,
        networkCluster: tenant.networkCluster,
        creatorWallet: tenant.creatorWallet,
        createdAt: tenant.createdAt,
        updatedAt: tenant.updatedAt,
        defaultStreamType: tenant.defaultStreamType,
        defaultFundingType: tenant.defaultFundingType,
        enabledStreamTypes: tenant.enabledStreamTypes || {
          enableStream: true,
          enableMeeting: true,
          enablePodcast: false
        },
        authorizedDomains: tenant.authorizedDomains.map((d) => d.domain),
      },
    });
  } catch (error) {
    console.error("Error fetching tenant:", error);
    return res.status(500).json({ error: "Failed to fetch tenant information" });
  } finally {
    await db.$disconnect();
  }
};