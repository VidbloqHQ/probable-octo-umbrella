import { StreamSessionType, StreamFundingType } from "@prisma/client";
import { db, executeQuery, trackQuery } from "../prisma.js";
// Cache for tenant info
const tenantInfoCache = new Map();
const TENANT_INFO_CACHE_TTL = 300000; // 5 minutes
/**
 * Controller for getting all tenant information - FIXED WITH SINGLE RESPONSE
 */
export const getTenantInfo = async (req, res) => {
    // Guard: Check if response already sent at the very beginning
    if (res.headersSent) {
        console.log(`[getTenantInfo] Response already sent at start`);
        return;
    }
    let success = false;
    try {
        const abortController = req.abortController;
        if (abortController?.signal?.aborted) {
            console.log(`[getTenantInfo] Request already aborted at start`);
            return;
        }
        // Ensure tenant is authenticated via middleware
        if (!req.tenant || !req.tenant.id) {
            res.status(401).json({ error: "Authenticated tenant required" });
            return; // CRITICAL: Return immediately after sending response
        }
        const tenantId = req.tenant.id;
        // Check cache first
        const cached = tenantInfoCache.get(tenantId);
        if (cached && Date.now() - cached.timestamp < TENANT_INFO_CACHE_TTL) {
            success = true;
            res.status(200).json(cached.data);
            return; // CRITICAL: Return immediately after sending response
        }
        // Check before query
        if (res.headersSent || abortController?.signal?.aborted) {
            console.log(`[getTenantInfo] Aborted before query`);
            return;
        }
        // Fetch tenant with all related info - WITH REDUCED TIMEOUT
        const tenant = await executeQuery(() => db.tenant.findUnique({
            where: { id: tenantId },
            include: {
                authorizedDomains: {
                    select: { domain: true },
                    take: 100 // Limit domains
                },
                enabledStreamTypes: true,
            },
        }), { maxRetries: 1, timeout: 2000 } // Reduced from 3000
        );
        // Check after query
        if (res.headersSent || abortController?.signal?.aborted) {
            console.log(`[getTenantInfo] Response sent/aborted after query`);
            return;
        }
        if (!tenant) {
            res.status(404).json({ error: "Tenant not found" });
            return; // CRITICAL: Return immediately after sending response
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
        // Final check before sending
        if (res.headersSent) {
            console.log(`[getTenantInfo] Response already sent before final send`);
            return;
        }
        res.status(200).json(response);
        return; // CRITICAL: Return immediately after sending response
    }
    catch (error) {
        console.error("Error fetching tenant:", error);
        // Check before sending error response
        if (res.headersSent) {
            console.log(`[getTenantInfo] Error after response sent`);
            return;
        }
        const abortController = req.abortController;
        if (abortController?.signal?.aborted) {
            console.log(`[getTenantInfo] Error after abort`);
            return;
        }
        // Handle timeout specifically
        if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
            res.status(504).json({
                error: "Database query timeout",
                message: "The request took too long. Please try again."
            });
            return;
        }
        res.status(500).json({ error: "Failed to fetch tenant information" });
        return;
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for updating tenant settings - FIXED WITH ABORT CHECKING
 */
export const updateTenant = async (req, res) => {
    let success = false;
    const errors = [];
    const updates = [];
    try {
        const abortController = req.abortController;
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
        if (!req.tenant || !req.tenant.id) {
            return res.status(401).json({ error: "Authenticated tenant required" });
        }
        const tenantId = req.tenant.id;
        const { name, theme, primaryColor, secondaryColor, accentColor, textPrimaryColor, textSecondaryColor, logo, shortLogo, templateId, rpcEndpoint, networkCluster, defaultStreamType, defaultFundingType, enabledStreamTypes, authorizedDomains, } = req.body;
        // Prepare tenant update data
        const updateData = {};
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
        // Check abort before updates
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
        // Step 1: Update tenant basic information (if needed) - WITH TIMEOUT
        if (Object.keys(updateData).length > 0) {
            try {
                await executeQuery(() => db.tenant.update({
                    where: { id: tenantId },
                    data: updateData,
                }), { maxRetries: 1, timeout: 2000 } // Reduced timeout
                );
                updates.push("Tenant settings updated");
            }
            catch (error) {
                console.error("Failed to update tenant:", error);
                if (error.message === 'Query timeout') {
                    return res.status(504).json({
                        error: "Database query timeout",
                        message: "The update took too long. Please try again."
                    });
                }
                errors.push(`Tenant update failed: ${error.message}`);
            }
        }
        // Check abort between operations
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
        // Step 2: Handle enabled stream types (upsert) - WITH TIMEOUT
        if (enabledStreamTypes !== undefined) {
            try {
                await executeQuery(() => db.enabledStreamTypes.upsert({
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
                }), { maxRetries: 1, timeout: 2000 } // Reduced timeout
                );
                updates.push("Stream types updated");
            }
            catch (error) {
                console.error("Failed to update stream types:", error);
                errors.push(`Stream types update failed: ${error.message}`);
            }
        }
        // Check abort before domain operations
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
        // Step 3: Handle authorized domains - WITH TIMEOUT AND LIMITS
        if (authorizedDomains && Array.isArray(authorizedDomains)) {
            // Limit to prevent timeout
            const domainsToProcess = authorizedDomains.slice(0, 50);
            // Get existing domains
            const existingDomains = await executeQuery(() => db.authorizedDomain.findMany({
                where: { tenantId },
                select: { domain: true, id: true },
                take: 200 // Limit
            }), { maxRetries: 1, timeout: 2000 });
            const existingDomainSet = new Set(existingDomains.map(d => d.domain));
            const newDomainSet = new Set(domainsToProcess);
            // Domains to add (limit to 20 to prevent timeout)
            const domainsToAdd = domainsToProcess
                .filter(domain => !existingDomainSet.has(domain))
                .slice(0, 20);
            // Domains to remove (limit to 20)
            const domainsToRemove = existingDomains
                .filter(d => !newDomainSet.has(d.domain))
                .slice(0, 20);
            // Add new domains
            if (domainsToAdd.length > 0) {
                try {
                    await executeQuery(() => db.authorizedDomain.createMany({
                        data: domainsToAdd.map(domain => ({ domain, tenantId })),
                        skipDuplicates: true
                    }), { maxRetries: 1, timeout: 3000 });
                    updates.push(`Added ${domainsToAdd.length} domains`);
                }
                catch (error) {
                    errors.push(`Failed to add domains: ${error.message}`);
                }
            }
            // Remove old domains
            if (domainsToRemove.length > 0) {
                try {
                    await executeQuery(() => db.authorizedDomain.deleteMany({
                        where: {
                            tenantId,
                            id: { in: domainsToRemove.map(d => d.id) }
                        }
                    }), { maxRetries: 1, timeout: 3000 });
                    updates.push(`Removed ${domainsToRemove.length} domains`);
                }
                catch (error) {
                    errors.push(`Failed to remove domains: ${error.message}`);
                }
            }
        }
        // Clear cache after updates
        tenantInfoCache.delete(tenantId);
        // Check abort before final fetch
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
        // Fetch updated tenant with timeout
        const fullTenant = await executeQuery(() => db.tenant.findUnique({
            where: { id: tenantId },
            include: {
                authorizedDomains: {
                    select: { domain: true },
                    take: 100 // Limit
                },
                enabledStreamTypes: true,
            },
        }), { maxRetries: 1, timeout: 3000 });
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
        // Final check before response
        if (!res.headersSent && !abortController?.signal?.aborted) {
            // Return appropriate status based on outcome
            if (errors.length > 0 && updates.length === 0) {
                // All operations failed
                return res.status(400).json(response);
            }
            else if (errors.length > 0 && updates.length > 0) {
                // Partial success
                return res.status(207).json(response); // 207 Multi-Status
            }
            else {
                // Complete success
                return res.status(200).json(response);
            }
        }
    }
    catch (error) {
        console.error("Error updating tenant:", error);
        const abortController = req.abortController;
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
        if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
            return res.status(504).json({
                error: "Database query timeout",
                message: "The operation took too long. Please try again."
            });
        }
        return res.status(500).json({ error: "Failed to update tenant" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Get all authorized domains for the current tenant - FIXED
 */
export const getAuthorizedDomains = async (req, res) => {
    let success = false;
    try {
        const abortController = req.abortController;
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
        const tenant = req.tenant;
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        const domains = await executeQuery(() => db.authorizedDomain.findMany({
            where: { tenantId: tenant.id },
            select: {
                id: true,
                domain: true,
                createdAt: true
            },
            orderBy: { createdAt: 'desc' },
            take: 200 // Limit to prevent timeout
        }), { maxRetries: 1, timeout: 3000 } // Reduced timeout
        );
        success = true;
        if (!res.headersSent && !abortController?.signal?.aborted) {
            res.status(200).json({
                domains,
                count: domains.length
            });
        }
    }
    catch (error) {
        console.error("Error fetching authorized domains:", error);
        if (res.headersSent)
            return;
        if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
            return res.status(504).json({
                error: "Database query timeout",
                message: "The request took too long. Please try again."
            });
        }
        res.status(500).json({ error: "Internal server error" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Add a new authorized domain for the current tenant
 */
export const addAuthorizedDomain = async (req, res) => {
    let success = false;
    try {
        const abortController = req.abortController;
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
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
        const existing = await executeQuery(() => db.authorizedDomain.findFirst({
            where: {
                domain: normalizedDomain,
                tenantId: tenant.id
            }
        }), { maxRetries: 1, timeout: 2000 });
        if (existing) {
            return res.status(409).json({
                error: "Domain already authorized for this tenant",
                domain: normalizedDomain
            });
        }
        // Create the authorized domain
        const authorizedDomain = await executeQuery(() => db.authorizedDomain.create({
            data: {
                domain: normalizedDomain,
                tenantId: tenant.id
            }
        }), { maxRetries: 2, timeout: 3000 });
        success = true;
        if (!res.headersSent && !abortController?.signal?.aborted) {
            res.status(201).json({
                message: "Domain authorized successfully",
                domain: authorizedDomain
            });
        }
    }
    catch (error) {
        console.error("Error adding authorized domain:", error);
        if (res.headersSent)
            return;
        res.status(500).json({ error: "Internal server error" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Remove an authorized domain for the current tenant
 */
export const removeAuthorizedDomain = async (req, res) => {
    let success = false;
    try {
        const abortController = req.abortController;
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
        const tenant = req.tenant;
        const { domainId } = req.params;
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!domainId) {
            return res.status(400).json({ error: "Domain ID is required" });
        }
        // Check if domain exists and belongs to this tenant
        const domain = await executeQuery(() => db.authorizedDomain.findFirst({
            where: {
                id: domainId,
                tenantId: tenant.id
            }
        }), { maxRetries: 1, timeout: 2000 });
        if (!domain) {
            return res.status(404).json({ error: "Authorized domain not found" });
        }
        // Delete the domain
        await executeQuery(() => db.authorizedDomain.delete({
            where: { id: domainId }
        }), { maxRetries: 2, timeout: 3000 });
        success = true;
        if (!res.headersSent && !abortController?.signal?.aborted) {
            res.status(200).json({
                message: "Domain removed successfully",
                domain: domain.domain
            });
        }
    }
    catch (error) {
        console.error("Error removing authorized domain:", error);
        if (res.headersSent)
            return;
        res.status(500).json({ error: "Internal server error" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Bulk add authorized domains
 */
export const bulkAddAuthorizedDomains = async (req, res) => {
    let success = false;
    try {
        const abortController = req.abortController;
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
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
            added: [],
            skipped: [],
            errors: []
        };
        for (const domain of domains) {
            try {
                // Check abort in loop
                if (res.headersSent || abortController?.signal?.aborted) {
                    break;
                }
                // Normalize domain (KEEP subdomains)
                let normalizedDomain = domain.trim().toLowerCase()
                    .replace(/^https?:\/\//, '')
                    .replace(/\/$/, '');
                // Check if already exists
                const existing = await executeQuery(() => db.authorizedDomain.findFirst({
                    where: {
                        domain: normalizedDomain,
                        tenantId: tenant.id
                    }
                }), { maxRetries: 1, timeout: 2000 });
                if (existing) {
                    results.skipped.push(normalizedDomain);
                    continue;
                }
                // Create domain
                await executeQuery(() => db.authorizedDomain.create({
                    data: {
                        domain: normalizedDomain,
                        tenantId: tenant.id
                    }
                }), { maxRetries: 1, timeout: 2000 });
                results.added.push(normalizedDomain);
            }
            catch (error) {
                results.errors.push(domain);
            }
        }
        success = true;
        if (!res.headersSent && !abortController?.signal?.aborted) {
            res.status(200).json({
                message: "Bulk domain authorization completed",
                results
            });
        }
    }
    catch (error) {
        console.error("Error in bulk domain authorization:", error);
        if (res.headersSent)
            return;
        res.status(500).json({ error: "Internal server error" });
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
