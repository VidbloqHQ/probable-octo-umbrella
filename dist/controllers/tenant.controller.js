import { db, executeQuery, trackQuery } from "../prisma.js";
import { generateApiKeyData, isValidWalletAddress } from "../utils/index.js";
// Cache for API keys list
const apiKeysCache = new Map();
const API_KEYS_CACHE_TTL = 60000; // 1 minute
/**
 * Controller for creating a new tenant - REFACTORED WITHOUT TRANSACTIONS
 */
export const createTenant = async (req, res) => {
    let success = false;
    try {
        const { creatorWallet } = req.body;
        if (!creatorWallet || !isValidWalletAddress(creatorWallet)) {
            return res.status(400).json({
                error: "Valid wallet address required",
            });
        }
        // Check if tenant already exists
        const existingTenant = await executeQuery(() => db.tenant.findUnique({
            where: { creatorWallet },
            select: { id: true }
        }), { maxRetries: 1, timeout: 3000 });
        if (existingTenant) {
            return res.status(400).json({
                error: "Tenant already exists for this wallet address"
            });
        }
        // Generate API key data
        const apiKeyData = await generateApiKeyData("Default API Key");
        // Step 1: Create tenant (atomic operation)
        const tenant = await executeQuery(() => db.tenant.create({
            data: {
                creatorWallet,
            },
        }), { maxRetries: 2, timeout: 5000 });
        // Step 2: Create API key (separate operation with compensation)
        let apiKey;
        try {
            apiKey = await executeQuery(() => db.apiToken.create({
                data: {
                    key: apiKeyData.key,
                    secret: apiKeyData.hashedSecret,
                    name: apiKeyData.name,
                    tenantId: tenant.id,
                    expiresAt: apiKeyData.expiresAt,
                },
            }), { maxRetries: 2, timeout: 5000 });
        }
        catch (error) {
            // Compensation: Delete the tenant if API key creation fails
            console.error("Failed to create API key, rolling back tenant:", error);
            await executeQuery(() => db.tenant.delete({
                where: { id: tenant.id }
            }), { maxRetries: 1, timeout: 3000 }).catch(err => {
                console.error("Failed to rollback tenant:", err);
            });
            throw new Error("Failed to create API key for tenant");
        }
        success = true;
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
    }
    catch (error) {
        console.error("Error creating tenant:", error);
        return res.status(500).json({ error: "Failed to create tenant" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for generating new API keys for an existing tenant - OPTIMIZED
 */
export const generateApiKey = async (req, res) => {
    let success = false;
    try {
        const { tenantId } = req.params;
        const { name, expiryDays } = req.body;
        if (!name) {
            return res.status(400).json({ error: "API key name is required" });
        }
        // Verify tenant exists
        const tenant = await executeQuery(() => db.tenant.findUnique({
            where: { id: tenantId },
            select: { id: true }
        }), { maxRetries: 1, timeout: 5000 });
        if (!tenant) {
            return res.status(404).json({ error: "Tenant not found" });
        }
        // Check for duplicate key name
        const existingKey = await executeQuery(() => db.apiToken.findFirst({
            where: {
                tenantId,
                name,
                isActive: true
            },
            select: { id: true }
        }), { maxRetries: 1, timeout: 5000 });
        if (existingKey) {
            return res.status(400).json({
                error: "An active API key with this name already exists"
            });
        }
        // Generate API key data
        const apiKeyData = await generateApiKeyData(name, expiryDays);
        // Create the API key in the database
        const apiKey = await executeQuery(() => db.apiToken.create({
            data: {
                key: apiKeyData.key,
                secret: apiKeyData.hashedSecret,
                name: apiKeyData.name,
                tenantId,
                expiresAt: apiKeyData.expiresAt,
            },
            select: {
                id: true,
                name: true,
                key: true,
                createdAt: true,
                expiresAt: true,
            }
        }), { maxRetries: 2, timeout: 10000 });
        // Invalidate cache
        apiKeysCache.delete(tenantId);
        success = true;
        return res.status(201).json({
            id: apiKey.id,
            name: apiKey.name,
            key: apiKey.key,
            secret: apiKeyData.rawSecret, // Only returned once
            createdAt: apiKey.createdAt,
            expiresAt: apiKey.expiresAt,
        });
    }
    catch (error) {
        console.error("Error generating API key:", error);
        return res.status(500).json({ error: "Failed to generate API key" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for listing a tenant's API keys - OPTIMIZED
 */
export const listApiKeys = async (req, res) => {
    let success = false;
    try {
        const { tenantId } = req.params;
        // Check cache first
        const cached = apiKeysCache.get(tenantId);
        if (cached && Date.now() - cached.timestamp < API_KEYS_CACHE_TTL) {
            success = true;
            return res.status(200).json(cached.data);
        }
        // Verify tenant exists and get API keys in parallel
        const [tenant, apiKeys] = await Promise.all([
            executeQuery(() => db.tenant.findUnique({
                where: { id: tenantId },
                select: { id: true }
            }), { maxRetries: 1, timeout: 5000 }),
            executeQuery(() => db.apiToken.findMany({
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
                orderBy: {
                    createdAt: 'desc'
                }
            }), { maxRetries: 2, timeout: 10000 })
        ]);
        if (!tenant) {
            return res.status(404).json({ error: "Tenant not found" });
        }
        // Cache the results
        apiKeysCache.set(tenantId, { data: apiKeys, timestamp: Date.now() });
        success = true;
        return res.status(200).json(apiKeys);
    }
    catch (error) {
        console.error("Error listing API keys:", error);
        return res.status(500).json({ error: "Failed to list API keys" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for revoking (deactivating) an API key - OPTIMIZED
 */
export const revokeApiKey = async (req, res) => {
    let success = false;
    try {
        const { tenantId, keyId } = req.params;
        // Check if API key exists and belongs to the tenant
        const apiKey = await executeQuery(() => db.apiToken.findFirst({
            where: {
                id: keyId,
                tenantId,
            },
            select: {
                id: true,
                isActive: true,
                name: true
            }
        }), { maxRetries: 1, timeout: 5000 });
        if (!apiKey) {
            return res.status(404).json({ error: "API key not found" });
        }
        if (!apiKey.isActive) {
            return res.status(400).json({ error: "API key is already revoked" });
        }
        // Deactivate the key
        await executeQuery(() => db.apiToken.update({
            where: { id: keyId },
            data: { isActive: false },
        }), { maxRetries: 2, timeout: 10000 });
        // Invalidate cache
        apiKeysCache.delete(tenantId);
        success = true;
        return res.status(200).json({
            message: "API key revoked successfully",
            keyName: apiKey.name
        });
    }
    catch (error) {
        console.error("Error revoking API key:", error);
        return res.status(500).json({ error: "Failed to revoke API key" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for getting tenant details (public endpoint)
 */
export const getTenant = async (req, res) => {
    let success = false;
    try {
        const { tenantId } = req.params;
        if (!tenantId) {
            return res.status(400).json({ error: "Tenant ID is required" });
        }
        // Get basic tenant info (public data only)
        const tenant = await executeQuery(() => db.tenant.findUnique({
            where: { id: tenantId },
            select: {
                id: true,
                name: true,
                logo: true,
                primaryColor: true,
                secondaryColor: true,
                accentColor: true,
                textPrimaryColor: true,
                textSecondaryColor: true,
                theme: true,
                createdAt: true,
                // Don't expose sensitive data like creatorWallet
            }
        }), { maxRetries: 2, timeout: 10000 });
        if (!tenant) {
            return res.status(404).json({ error: "Tenant not found" });
        }
        success = true;
        return res.status(200).json(tenant);
    }
    catch (error) {
        console.error("Error fetching tenant:", error);
        return res.status(500).json({ error: "Failed to fetch tenant" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for checking if a wallet has a tenant
 */
export const checkTenantByWallet = async (req, res) => {
    let success = false;
    try {
        const { wallet } = req.params;
        if (!wallet || !isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Valid wallet address is required" });
        }
        const tenant = await executeQuery(() => db.tenant.findUnique({
            where: { creatorWallet: wallet },
            select: {
                id: true,
                name: true,
                createdAt: true,
            }
        }), { maxRetries: 1, timeout: 5000 });
        success = true;
        if (!tenant) {
            return res.status(200).json({
                exists: false,
                message: "No tenant found for this wallet"
            });
        }
        return res.status(200).json({
            exists: true,
            tenant: {
                id: tenant.id,
                name: tenant.name,
                createdAt: tenant.createdAt
            }
        });
    }
    catch (error) {
        console.error("Error checking tenant by wallet:", error);
        return res.status(500).json({ error: "Failed to check tenant" });
    }
    finally {
        trackQuery(success);
    }
};
// Periodic cache cleanup
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of apiKeysCache.entries()) {
        if (now - value.timestamp > API_KEYS_CACHE_TTL) {
            apiKeysCache.delete(key);
        }
    }
}, 60000); // Clean every minute
