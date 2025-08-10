import { StreamSessionType, StreamFundingType } from "@prisma/client";
import { db, executeQuery, executeTransaction, trackQuery } from "../prisma.js";
// Cache for tenant info
const tenantInfoCache = new Map();
const TENANT_INFO_CACHE_TTL = 300000; // 5 minutes
/**
 * Controller for updating tenant settings - OPTIMIZED
 */
export const updateTenant = async (req, res) => {
    let success = false;
    try {
        // Authentication check
        if (!req.tenant || !req.tenant.id) {
            return res.status(401).json({ error: "Authenticated tenant required" });
        }
        const tenantId = req.tenant.id;
        // Extract updatable fields from request body
        const { name, theme, primaryColor, secondaryColor, accentColor, textPrimaryColor, textSecondaryColor, logo, shortLogo, templateId, rpcEndpoint, networkCluster, defaultStreamType, defaultFundingType, enabledStreamTypes, authorizedDomains, } = req.body;
        // Prepare the data for update
        const updateData = {};
        // Only include fields that are provided
        if (name !== undefined)
            updateData.name = name;
        if (theme !== undefined)
            updateData.theme = theme;
        if (primaryColor !== undefined)
            updateData.primaryColor = primaryColor;
        if (secondaryColor !== undefined)
            updateData.secondaryColor = secondaryColor;
        if (accentColor !== undefined)
            updateData.accentColor = accentColor;
        if (textPrimaryColor !== undefined)
            updateData.textPrimaryColor = textPrimaryColor;
        if (textSecondaryColor !== undefined)
            updateData.textSecondaryColor = textSecondaryColor;
        if (logo !== undefined)
            updateData.logo = logo;
        if (shortLogo !== undefined)
            updateData.shortLogo = shortLogo;
        if (templateId !== undefined)
            updateData.templateId = templateId;
        if (rpcEndpoint !== undefined)
            updateData.rpcEndpoint = rpcEndpoint;
        if (networkCluster !== undefined)
            updateData.networkCluster = networkCluster;
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
        // Use transaction for all updates
        await executeTransaction(async (tx) => {
            // Update tenant basic information
            await tx.tenant.update({
                where: { id: tenantId },
                data: updateData,
            });
            // Handle enabled stream types if provided
            if (enabledStreamTypes !== undefined) {
                const existingEnabledTypes = await tx.enabledStreamTypes.findUnique({
                    where: { tenantId },
                });
                if (existingEnabledTypes) {
                    await tx.enabledStreamTypes.update({
                        where: { tenantId },
                        data: {
                            enableStream: enabledStreamTypes.enableStream ?? existingEnabledTypes.enableStream,
                            enableMeeting: enabledStreamTypes.enableMeeting ?? existingEnabledTypes.enableMeeting,
                            enablePodcast: enabledStreamTypes.enablePodcast ?? existingEnabledTypes.enablePodcast,
                        },
                    });
                }
                else {
                    await tx.enabledStreamTypes.create({
                        data: {
                            tenantId,
                            enableStream: enabledStreamTypes.enableStream ?? true,
                            enableMeeting: enabledStreamTypes.enableMeeting ?? true,
                            enablePodcast: enabledStreamTypes.enablePodcast ?? false,
                        },
                    });
                }
            }
            // Handle authorized domains if provided
            if (authorizedDomains && Array.isArray(authorizedDomains)) {
                const existingDomains = await tx.authorizedDomain.findMany({
                    where: { tenantId },
                    select: { domain: true },
                });
                const existingDomainSet = new Set(existingDomains.map((d) => d.domain));
                const newDomainSet = new Set(authorizedDomains);
                const domainsToAdd = authorizedDomains.filter((domain) => !existingDomainSet.has(domain));
                const domainsToRemove = [...existingDomainSet].filter((domain) => !newDomainSet.has(domain));
                // Batch operations
                if (domainsToAdd.length > 0) {
                    await tx.authorizedDomain.createMany({
                        data: domainsToAdd.map(domain => ({ domain, tenantId }))
                    });
                }
                if (domainsToRemove.length > 0) {
                    await tx.authorizedDomain.deleteMany({
                        where: {
                            tenantId,
                            domain: { in: domainsToRemove },
                        },
                    });
                }
            }
        }, { maxWait: 10000, timeout: 30000 });
        // Clear cache after update
        tenantInfoCache.delete(tenantId);
        // Fetch updated tenant with all related info
        const fullTenant = await executeQuery(() => db.tenant.findUnique({
            where: { id: tenantId },
            include: {
                authorizedDomains: {
                    select: { domain: true },
                },
                enabledStreamTypes: true,
            },
        }), { maxRetries: 2, timeout: 10000 });
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
        };
        success = true;
        return res.status(200).json(response);
    }
    catch (error) {
        console.error("Error updating tenant:", error);
        return res.status(500).json({ error: "Failed to update tenant" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for getting all tenant information - OPTIMIZED
 */
export const getTenantInfo = async (req, res) => {
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
        const tenant = await executeQuery(() => db.tenant.findUnique({
            where: { id: tenantId },
            include: {
                authorizedDomains: {
                    select: { domain: true },
                },
                enabledStreamTypes: true,
            },
        }), { maxRetries: 2, timeout: 10000 });
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
    }
    catch (error) {
        console.error("Error fetching tenant:", error);
        return res.status(500).json({ error: "Failed to fetch tenant information" });
    }
    finally {
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
