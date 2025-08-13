import { Response } from "express";
import { StreamSessionType, StreamFundingType } from "@prisma/client";
import { db, executeQuery, trackQuery } from "../prisma.js";
import { TenantRequest } from "../types/index.js";

// Cache for tenant info
const tenantInfoCache = new Map<string, { data: any; timestamp: number }>();
const TENANT_INFO_CACHE_TTL = 300000; // 5 minutes

/**
 * Controller for updating tenant settings - OPTIMIZED
 */
// export const updateTenant = async (req: TenantRequest, res: Response) => {
//   let success = false;
  
//   try {
//     // Authentication check
//     if (!req.tenant || !req.tenant.id) {
//       return res.status(401).json({ error: "Authenticated tenant required" });
//     }

//     const tenantId = req.tenant.id;
    
//     // Extract updatable fields from request body
//     const {
//       name,
//       theme,
//       primaryColor,
//       secondaryColor,
//       accentColor,
//       textPrimaryColor,
//       textSecondaryColor,
//       logo,
//       shortLogo,
//       templateId,
//       rpcEndpoint,
//       networkCluster,
//       defaultStreamType,
//       defaultFundingType,
//       enabledStreamTypes,
//       authorizedDomains,
//     } = req.body;

//     // Prepare the data for update
//     const updateData: any = {};

//     // Only include fields that are provided
//     if (name !== undefined) updateData.name = name;
//     if (theme !== undefined) updateData.theme = theme;
//     if (primaryColor !== undefined) updateData.primaryColor = primaryColor;
//     if (secondaryColor !== undefined) updateData.secondaryColor = secondaryColor;
//     if (accentColor !== undefined) updateData.accentColor = accentColor;
//     if (textPrimaryColor !== undefined) updateData.textPrimaryColor = textPrimaryColor;
//     if (textSecondaryColor !== undefined) updateData.textSecondaryColor = textSecondaryColor;
//     if (logo !== undefined) updateData.logo = logo;
//     if (shortLogo !== undefined) updateData.shortLogo = shortLogo;
//     if (templateId !== undefined) updateData.templateId = templateId;
//     if (rpcEndpoint !== undefined) updateData.rpcEndpoint = rpcEndpoint;
//     if (networkCluster !== undefined) updateData.networkCluster = networkCluster;

//     // Validate stream types
//     if (defaultStreamType !== undefined) {
//       if (!Object.values(StreamSessionType).includes(defaultStreamType)) {
//         return res.status(400).json({
//           error: "Invalid defaultStreamType",
//           validOptions: Object.values(StreamSessionType),
//         });
//       }
//       updateData.defaultStreamType = defaultStreamType;
//     }

//     if (defaultFundingType !== undefined) {
//       if (!Object.values(StreamFundingType).includes(defaultFundingType)) {
//         return res.status(400).json({
//           error: "Invalid defaultFundingType",
//           validOptions: Object.values(StreamFundingType),
//         });
//       }
//       updateData.defaultFundingType = defaultFundingType;
//     }

//     // Use transaction for all updates
//     await executeTransaction(async (tx) => {
//       // Update tenant basic information
//       await tx.tenant.update({
//         where: { id: tenantId },
//         data: updateData,
//       });

//       // Handle enabled stream types if provided
//       if (enabledStreamTypes !== undefined) {
//         const existingEnabledTypes = await tx.enabledStreamTypes.findUnique({
//           where: { tenantId },
//         });

//         if (existingEnabledTypes) {
//           await tx.enabledStreamTypes.update({
//             where: { tenantId },
//             data: {
//               enableStream: enabledStreamTypes.enableStream ?? existingEnabledTypes.enableStream,
//               enableMeeting: enabledStreamTypes.enableMeeting ?? existingEnabledTypes.enableMeeting,
//               enablePodcast: enabledStreamTypes.enablePodcast ?? existingEnabledTypes.enablePodcast,
//             },
//           });
//         } else {
//           await tx.enabledStreamTypes.create({
//             data: {
//               tenantId,
//               enableStream: enabledStreamTypes.enableStream ?? true,
//               enableMeeting: enabledStreamTypes.enableMeeting ?? true,
//               enablePodcast: enabledStreamTypes.enablePodcast ?? false,
//             },
//           });
//         }
//       }

//       // Handle authorized domains if provided
//       if (authorizedDomains && Array.isArray(authorizedDomains)) {
//         const existingDomains = await tx.authorizedDomain.findMany({
//           where: { tenantId },
//           select: { domain: true },
//         });

//         const existingDomainSet = new Set(existingDomains.map((d: { domain: any; }) => d.domain));
//         const newDomainSet = new Set(authorizedDomains);

//         const domainsToAdd = authorizedDomains.filter(
//           (domain) => !existingDomainSet.has(domain)
//         );

//         const domainsToRemove = [...existingDomainSet].filter(
//           (domain) => !newDomainSet.has(domain)
//         );

//         // Batch operations
//         if (domainsToAdd.length > 0) {
//           await tx.authorizedDomain.createMany({
//             data: domainsToAdd.map(domain => ({ domain, tenantId }))
//           });
//         }

//         if (domainsToRemove.length > 0) {
//           await tx.authorizedDomain.deleteMany({
//             where: {
//               tenantId,
//               domain: { in: domainsToRemove },
//             },
//           });
//         }
//       }
//     }, { maxWait: 10000, timeout: 30000 });

//     // Clear cache after update
//     tenantInfoCache.delete(tenantId);

//     // Fetch updated tenant with all related info
//     const fullTenant = await executeQuery(
//       () => db.tenant.findUnique({
//         where: { id: tenantId },
//         include: {
//           authorizedDomains: {
//             select: { domain: true },
//           },
//           enabledStreamTypes: true,
//         },
//       }),
//       { maxRetries: 2, timeout: 10000 }
//     );

//     if (!fullTenant) {
//       return res.status(404).json({ error: "Tenant not found" });
//     }

//     // Format the response
//     const response = {
//       tenant: {
//         id: fullTenant.id,
//         name: fullTenant.name,
//         theme: fullTenant.theme,
//         primaryColor: fullTenant.primaryColor,
//         secondaryColor: fullTenant.secondaryColor,
//         accentColor: fullTenant.accentColor,
//         textPrimaryColor: fullTenant.textPrimaryColor,
//         textSecondaryColor: fullTenant.textSecondaryColor,
//         logo: fullTenant.logo,
//         shortLogo: fullTenant.shortLogo,
//         templateId: fullTenant.templateId,
//         rpcEndpoint: fullTenant.rpcEndpoint,
//         networkCluster: fullTenant.networkCluster,
//         creatorWallet: fullTenant.creatorWallet,
//         createdAt: fullTenant.createdAt,
//         updatedAt: fullTenant.updatedAt,
//         defaultStreamType: fullTenant.defaultStreamType,
//         defaultFundingType: fullTenant.defaultFundingType,
//         enabledStreamTypes: fullTenant.enabledStreamTypes || {
//           enableStream: true,
//           enableMeeting: true,
//           enablePodcast: false,
//         },
//         authorizedDomains: fullTenant.authorizedDomains.map((d) => d.domain),
//       },
//     };

//     success = true;
//     return res.status(200).json(response);
//   } catch (error) {
//     console.error("Error updating tenant:", error);
//     return res.status(500).json({ error: "Failed to update tenant" });
//   } finally {
//     trackQuery(success);
//   }
// };


/**
 * Controller for updating tenant settings - REFACTORED WITHOUT TRANSACTIONS
 */
export const updateTenant = async (req: TenantRequest, res: Response) => {
  let success = false;
  const errors: string[] = [];
  const updates: string[] = [];
  
  try {
    if (!req.tenant || !req.tenant.id) {
      return res.status(401).json({ error: "Authenticated tenant required" });
    }

    const tenantId = req.tenant.id;
    
    const {
      name,
      theme,
      primaryColor,
      secondaryColor,
      accentColor,
      textPrimaryColor,
      textSecondaryColor,
      logo,
      shortLogo,
      templateId,
      rpcEndpoint,
      networkCluster,
      defaultStreamType,
      defaultFundingType,
      enabledStreamTypes,
      authorizedDomains,
    } = req.body;

    // Prepare tenant update data
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (theme !== undefined) updateData.theme = theme;
    if (primaryColor !== undefined) updateData.primaryColor = primaryColor;
    if (secondaryColor !== undefined) updateData.secondaryColor = secondaryColor;
    if (accentColor !== undefined) updateData.accentColor = accentColor;
    if (textPrimaryColor !== undefined) updateData.textPrimaryColor = textPrimaryColor;
    if (textSecondaryColor !== undefined) updateData.textSecondaryColor = textSecondaryColor;
    if (logo !== undefined) updateData.logo = logo;
    if (shortLogo !== undefined) updateData.shortLogo = shortLogo;
    if (templateId !== undefined) updateData.templateId = templateId;
    if (rpcEndpoint !== undefined) updateData.rpcEndpoint = rpcEndpoint;
    if (networkCluster !== undefined) updateData.networkCluster = networkCluster;

    // Validate stream types
    if (defaultStreamType !== undefined) {
      if (!Object.values(StreamSessionType).includes(defaultStreamType)) {
        return res.status(400).json({
          error: "Invalid defaultStreamType",
          validOptions: Object.values(StreamSessionType),
        });
      }
      updateData.defaultStreamType = defaultStreamType;
    }

    if (defaultFundingType !== undefined) {
      if (!Object.values(StreamFundingType).includes(defaultFundingType)) {
        return res.status(400).json({
          error: "Invalid defaultFundingType",
          validOptions: Object.values(StreamFundingType),
        });
      }
      updateData.defaultFundingType = defaultFundingType;
    }

    // Step 1: Update tenant basic information (if needed)
    if (Object.keys(updateData).length > 0) {
      try {
        await executeQuery(
          () => db.tenant.update({
            where: { id: tenantId },
            data: updateData,
          }),
          { maxRetries: 2, timeout: 5000 }
        );
        updates.push("Tenant settings updated");
      } catch (error: any) {
        console.error("Failed to update tenant:", error);
        errors.push(`Tenant update failed: ${error.message}`);
      }
    }

    // Step 2: Handle enabled stream types (upsert)
    if (enabledStreamTypes !== undefined) {
      try {
        await executeQuery(
          () => db.enabledStreamTypes.upsert({
            where: { tenantId },
            update: {
              enableStream: enabledStreamTypes.enableStream ?? undefined,
              enableMeeting: enabledStreamTypes.enableMeeting ?? undefined,
              enablePodcast: enabledStreamTypes.enablePodcast ?? undefined,
            },
            create: {
              tenantId,
              enableStream: enabledStreamTypes.enableStream ?? true,
              enableMeeting: enabledStreamTypes.enableMeeting ?? true,
              enablePodcast: enabledStreamTypes.enablePodcast ?? false,
            },
          }),
          { maxRetries: 2, timeout: 5000 }
        );
        updates.push("Stream types updated");
      } catch (error: any) {
        console.error("Failed to update stream types:", error);
        errors.push(`Stream types update failed: ${error.message}`);
      }
    }

    // Step 3: Handle authorized domains (separate operations)
    if (authorizedDomains && Array.isArray(authorizedDomains)) {
      // Get existing domains
      const existingDomains = await executeQuery(
        () => db.authorizedDomain.findMany({
          where: { tenantId },
          select: { domain: true, id: true },
        }),
        { maxRetries: 1, timeout: 3000 }
      );

      const existingDomainSet = new Set(existingDomains.map(d => d.domain));
      const newDomainSet = new Set(authorizedDomains);

      // Domains to add
      const domainsToAdd = authorizedDomains.filter(
        domain => !existingDomainSet.has(domain)
      );

      // Domains to remove
      const domainsToRemove = existingDomains.filter(
        d => !newDomainSet.has(d.domain)
      );

      // Add new domains (parallel, independent operations)
      const addPromises = domainsToAdd.map(domain =>
        executeQuery(
          () => db.authorizedDomain.create({
            data: { domain, tenantId }
          }),
          { maxRetries: 1, timeout: 2000 }
        ).catch(err => {
          console.error(`Failed to add domain ${domain}:`, err);
          errors.push(`Failed to add domain: ${domain}`);
        })
      );

      // Remove old domains (parallel, independent operations)
      const removePromises = domainsToRemove.map(d =>
        executeQuery(
          () => db.authorizedDomain.delete({
            where: { id: d.id }
          }),
          { maxRetries: 1, timeout: 2000 }
        ).catch(err => {
          console.error(`Failed to remove domain ${d.domain}:`, err);
          errors.push(`Failed to remove domain: ${d.domain}`);
        })
      );

      // Execute all domain operations in parallel
      await Promise.allSettled([...addPromises, ...removePromises]);
      
      if (domainsToAdd.length > 0 || domainsToRemove.length > 0) {
        updates.push(`Domains updated: +${domainsToAdd.length}, -${domainsToRemove.length}`);
      }
    }

    // Clear cache after updates
    tenantInfoCache.delete(tenantId);

    // Fetch updated tenant with all related info
    const fullTenant = await executeQuery(
      () => db.tenant.findUnique({
        where: { id: tenantId },
        include: {
          authorizedDomains: {
            select: { domain: true },
          },
          enabledStreamTypes: true,
        },
      }),
      { maxRetries: 2, timeout: 5000 }
    );

    if (!fullTenant) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    // Format the response
    const response = {
      tenant: {
        id: fullTenant.id,
        name: fullTenant.name,
        theme: fullTenant.theme,
        primaryColor: fullTenant.primaryColor,
        secondaryColor: fullTenant.secondaryColor,
        accentColor: fullTenant.accentColor,
        textPrimaryColor: fullTenant.textPrimaryColor,
        textSecondaryColor: fullTenant.textSecondaryColor,
        logo: fullTenant.logo,
        shortLogo: fullTenant.shortLogo,
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
          enablePodcast: false,
        },
        authorizedDomains: fullTenant.authorizedDomains.map((d) => d.domain),
      },
      updates: updates.length > 0 ? updates : ["No changes made"],
      errors: errors.length > 0 ? errors : undefined,
    };

    success = errors.length === 0;
    
    // Return appropriate status based on outcome
    if (errors.length > 0 && updates.length === 0) {
      // All operations failed
      return res.status(400).json(response);
    } else if (errors.length > 0 && updates.length > 0) {
      // Partial success
      return res.status(207).json(response); // 207 Multi-Status
    } else {
      // Complete success
      return res.status(200).json(response);
    }
  } catch (error) {
    console.error("Error updating tenant:", error);
    return res.status(500).json({ error: "Failed to update tenant" });
  } finally {
    trackQuery(success);
  }
};

/**
 * Controller for getting all tenant information - OPTIMIZED
 */
export const getTenantInfo = async (req: TenantRequest, res: Response) => {
  let success = false;
  
  try {
    // Ensure tenant is authenticated via middleware
    if (!req.tenant || !req.tenant.id) {
      return res.status(401).json({ error: "Authenticated tenant required" });
    }
    
    const tenantId = req.tenant.id;

    // Check cache first
    const cached = tenantInfoCache.get(tenantId);
    if (cached && Date.now() - cached.timestamp < TENANT_INFO_CACHE_TTL) {
      success = true;
      return res.status(200).json(cached.data);
    }

    // Fetch tenant with all related info
    const tenant = await executeQuery(
      () => db.tenant.findUnique({
        where: { id: tenantId },
        include: {
          authorizedDomains: {
            select: { domain: true },
          },
          enabledStreamTypes: true,
        },
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    if (!tenant) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    // Format the response
    const response = {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        theme: tenant.theme,
        primaryColor: tenant.primaryColor,
        secondaryColor: tenant.secondaryColor,
        accentColor: tenant.accentColor,
        textPrimaryColor: tenant.textPrimaryColor,
        textSecondaryColor: tenant.textSecondaryColor,
        logo: tenant.logo,
        shortLogo: tenant.shortLogo,
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
          enablePodcast: false,
        },
        authorizedDomains: tenant.authorizedDomains.map((d) => d.domain),
      },
    };

    // Cache the response
    tenantInfoCache.set(tenantId, { data: response, timestamp: Date.now() });

    success = true;
    return res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching tenant:", error);
    return res.status(500).json({ error: "Failed to fetch tenant information" });
  } finally {
    trackQuery(success);
  }
};

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of tenantInfoCache.entries()) {
    if (now - value.timestamp > TENANT_INFO_CACHE_TTL) {
      tenantInfoCache.delete(key);
    }
  }
}, 300000); // Clean every 5 minutes

/**
 * Get all authorized domains for the current tenant
 */
export const getAuthorizedDomains = async (req: TenantRequest, res: Response) => {
  let success = false;
  
  try {
    const tenant = req.tenant;
    
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    const domains = await executeQuery(
      () => db.authorizedDomain.findMany({
        where: { tenantId: tenant.id },
        select: {
          id: true,
          domain: true,
          createdAt: true
        },
        orderBy: { createdAt: 'desc' }
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    success = true;
    res.status(200).json({
      domains,
      count: domains.length
    });
  } catch (error) {
    console.error("Error fetching authorized domains:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

/**
 * Add a new authorized domain for the current tenant
 */
export const addAuthorizedDomain = async (req: TenantRequest, res: Response) => {
  let success = false;
  
  try {
    const tenant = req.tenant;
    const { domain } = req.body;
    
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: "Domain is required" });
    }

    // Normalize domain (remove protocol if present but KEEP subdomains)
    let normalizedDomain = domain.trim().toLowerCase();
    
    // Remove protocol if present
    normalizedDomain = normalizedDomain
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, ''); // Remove trailing slash
    
    // DON'T remove www. or other subdomains - they should be treated as different domains
    
    // Validate domain format
    const domainRegex = /^([a-z0-9]+(-[a-z0-9]+)*\.)*[a-z0-9]+(-[a-z0-9]+)*(\.[a-z]{2,})(:[0-9]+)?$/;
    const isLocalhost = normalizedDomain.includes('localhost') || 
                       normalizedDomain.includes('127.0.0.1') ||
                       normalizedDomain.includes('::1');
    
    if (!domainRegex.test(normalizedDomain) && !isLocalhost) {
      return res.status(400).json({ 
        error: "Invalid domain format",
        hint: "Domain should be like 'example.com' or 'subdomain.example.com'"
      });
    }

    // Check if domain already exists for this tenant
    const existing = await executeQuery(
      () => db.authorizedDomain.findFirst({
        where: {
          domain: normalizedDomain,
          tenantId: tenant.id
        }
      }),
      { maxRetries: 1, timeout: 5000 }
    );

    if (existing) {
      return res.status(409).json({ 
        error: "Domain already authorized for this tenant",
        domain: normalizedDomain
      });
    }

    // Create the authorized domain
    const authorizedDomain = await executeQuery(
      () => db.authorizedDomain.create({
        data: {
          domain: normalizedDomain,
          tenantId: tenant.id
        }
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    success = true;
    res.status(201).json({
      message: "Domain authorized successfully",
      domain: authorizedDomain
    });
  } catch (error) {
    console.error("Error adding authorized domain:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

/**
 * Remove an authorized domain for the current tenant
 */
export const removeAuthorizedDomain = async (req: TenantRequest, res: Response) => {
  let success = false;
  
  try {
    const tenant = req.tenant;
    const { domainId } = req.params;
    
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!domainId) {
      return res.status(400).json({ error: "Domain ID is required" });
    }

    // Check if domain exists and belongs to this tenant
    const domain = await executeQuery(
      () => db.authorizedDomain.findFirst({
        where: {
          id: domainId,
          tenantId: tenant.id
        }
      }),
      { maxRetries: 1, timeout: 5000 }
    );

    if (!domain) {
      return res.status(404).json({ error: "Authorized domain not found" });
    }

    // Delete the domain
    await executeQuery(
      () => db.authorizedDomain.delete({
        where: { id: domainId }
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    success = true;
    res.status(200).json({
      message: "Domain removed successfully",
      domain: domain.domain
    });
  } catch (error) {
    console.error("Error removing authorized domain:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

/**
 * Bulk add authorized domains
 */
export const bulkAddAuthorizedDomains = async (req: TenantRequest, res: Response) => {
  let success = false;
  
  try {
    const tenant = req.tenant;
    const { domains } = req.body;
    
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!Array.isArray(domains) || domains.length === 0) {
      return res.status(400).json({ error: "Domains array is required" });
    }

    if (domains.length > 50) {
      return res.status(400).json({ error: "Maximum 50 domains can be added at once" });
    }

    const results = {
      added: [] as string[],
      skipped: [] as string[],
      errors: [] as string[]
    };

    for (const domain of domains) {
      try {
        // Normalize domain (KEEP subdomains)
        let normalizedDomain = domain.trim().toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/\/$/, '');
        // DON'T remove www. - treat as separate domain

        // Check if already exists
        const existing = await executeQuery(
          () => db.authorizedDomain.findFirst({
            where: {
              domain: normalizedDomain,
              tenantId: tenant.id
            }
          }),
          { maxRetries: 1, timeout: 5000 }
        );

        if (existing) {
          results.skipped.push(normalizedDomain);
          continue;
        }

        // Create domain
        await executeQuery(
          () => db.authorizedDomain.create({
            data: {
              domain: normalizedDomain,
              tenantId: tenant.id
            }
          }),
          { maxRetries: 1, timeout: 5000 }
        );

        results.added.push(normalizedDomain);
      } catch (error) {
        results.errors.push(domain);
      }
    }

    success = true;
    res.status(200).json({
      message: "Bulk domain authorization completed",
      results
    });
  } catch (error) {
    console.error("Error in bulk domain authorization:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};