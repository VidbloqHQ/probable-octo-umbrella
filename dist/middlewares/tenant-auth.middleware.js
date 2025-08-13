// import { Response, NextFunction } from "express";
// import * as bcrypt from "bcryptjs";
// import { db, executeQuery, trackQuery } from "../prisma.js";
// import { TenantRequest } from "../types/index.js";
import * as bcrypt from "bcryptjs";
import { db, executeQuery, trackQuery } from "../prisma.js";
// Cache configuration
const CACHE_TTL = parseInt(process.env.AUTH_CACHE_TTL || '300000'); // 5 minutes
const CACHE_MAX_SIZE = parseInt(process.env.AUTH_CACHE_MAX_SIZE || '500');
// Enhanced LRU cache with separate key and tenant caches
class TokenCache {
    keyCache = new Map();
    tenantCache = new Map();
    hits = 0;
    misses = 0;
    getKey(apiKey) {
        const entry = this.keyCache.get(apiKey);
        if (!entry) {
            this.misses++;
            return null;
        }
        if (Date.now() - entry.timestamp > CACHE_TTL) {
            this.keyCache.delete(apiKey);
            this.misses++;
            return null;
        }
        this.hits++;
        return entry.data;
    }
    getTenant(tenantId) {
        const entry = this.tenantCache.get(tenantId);
        if (!entry)
            return null;
        if (Date.now() - entry.timestamp > CACHE_TTL) {
            this.tenantCache.delete(tenantId);
            return null;
        }
        return entry.data;
    }
    setKey(apiKey, data) {
        // Enforce size limit
        if (this.keyCache.size >= CACHE_MAX_SIZE) {
            const firstKey = this.keyCache.keys().next().value;
            if (firstKey)
                this.keyCache.delete(firstKey);
        }
        this.keyCache.set(apiKey, { data, timestamp: Date.now() });
    }
    setTenant(tenantId, data) {
        // Enforce size limit
        if (this.tenantCache.size >= CACHE_MAX_SIZE / 2) {
            const firstKey = this.tenantCache.keys().next().value;
            if (firstKey)
                this.tenantCache.delete(firstKey);
        }
        this.tenantCache.set(tenantId, { data, timestamp: Date.now() });
    }
    clear() {
        this.keyCache.clear();
        this.tenantCache.clear();
        this.hits = 0;
        this.misses = 0;
    }
    getStats() {
        const hitRate = (this.hits + this.misses) > 0
            ? this.hits / (this.hits + this.misses)
            : 0;
        return {
            keyCache: this.keyCache.size,
            tenantCache: this.tenantCache.size,
            hits: this.hits,
            misses: this.misses,
            hitRate: (hitRate * 100).toFixed(2) + '%',
            ttl: CACHE_TTL
        };
    }
}
const tokenCache = new TokenCache();
// Validation cache for failed attempts
const validationCache = new Map();
const VALIDATION_CACHE_TTL = 5000; // 5 seconds
/**
 * OPTIMIZED authentication middleware - Split queries pattern
 */
export const authenticateTenant = async (req, res, next) => {
    // Skip authentication for OPTIONS requests (CORS preflight)
    if (req.method === 'OPTIONS') {
        return next();
    }
    const startTime = Date.now();
    let success = false;
    try {
        const apiKey = req.headers["x-api-key"];
        const apiSecret = req.headers["x-api-secret"];
        if (!apiKey || !apiSecret) {
            return res.status(401).json({
                error: "API credentials required",
                code: "MISSING_CREDENTIALS"
            });
        }
        const cacheKey = `${apiKey}:${apiSecret}`;
        // Check validation cache for recent failures
        const validationEntry = validationCache.get(cacheKey);
        if (validationEntry && Date.now() - validationEntry.timestamp < VALIDATION_CACHE_TTL) {
            if (!validationEntry.valid) {
                return res.status(401).json({
                    error: "Invalid API credentials",
                    code: "INVALID_CREDENTIALS_CACHED"
                });
            }
        }
        // STEP 1: Check API key cache
        let apiToken = tokenCache.getKey(apiKey);
        if (!apiToken) {
            // Cache miss - fetch ONLY the API token (lightweight query)
            apiToken = await executeQuery(() => db.apiToken.findUnique({
                where: { key: apiKey },
                select: {
                    id: true,
                    secret: true,
                    isActive: true,
                    expiresAt: true,
                    tenantId: true,
                }
            }), {
                maxRetries: 1,
                timeout: 3000 // Reduced timeout for first query
            });
            if (!apiToken) {
                validationCache.set(cacheKey, { valid: false, timestamp: Date.now() });
                return res.status(401).json({
                    error: "Invalid API key",
                    code: "INVALID_KEY"
                });
            }
            // Validate token status
            if (!apiToken.isActive) {
                validationCache.set(cacheKey, { valid: false, timestamp: Date.now() });
                return res.status(401).json({
                    error: "API key has been revoked",
                    code: "KEY_REVOKED"
                });
            }
            if (apiToken.expiresAt && new Date(apiToken.expiresAt) < new Date()) {
                validationCache.set(cacheKey, { valid: false, timestamp: Date.now() });
                return res.status(401).json({
                    error: "API key has expired",
                    code: "KEY_EXPIRED"
                });
            }
            // Cache the API token
            tokenCache.setKey(apiKey, apiToken);
        }
        // STEP 2: Verify secret (CPU-bound, fast)
        const validSecret = await bcrypt.compare(apiSecret, apiToken.secret);
        if (!validSecret) {
            validationCache.set(cacheKey, { valid: false, timestamp: Date.now() });
            return res.status(401).json({
                error: "Invalid API credentials",
                code: "INVALID_SECRET"
            });
        }
        // STEP 3: Get tenant data (check cache first)
        let tenant = tokenCache.getTenant(apiToken.tenantId);
        if (!tenant) {
            // Fetch tenant data separately
            tenant = await executeQuery(() => db.tenant.findUnique({
                where: { id: apiToken.tenantId },
                select: {
                    id: true,
                    creatorWallet: true,
                    createdAt: true,
                    updatedAt: true,
                    theme: true,
                    primaryColor: true,
                    secondaryColor: true,
                    accentColor: true,
                    textPrimaryColor: true,
                    textSecondaryColor: true,
                    logo: true,
                    shortLogo: true,
                    name: true,
                    templateId: true,
                    rpcEndpoint: true,
                    networkCluster: true,
                    defaultStreamType: true,
                    defaultFundingType: true,
                }
            }), {
                maxRetries: 1,
                timeout: 3000
            });
            if (!tenant) {
                return res.status(404).json({
                    error: "Tenant not found",
                    code: "TENANT_NOT_FOUND"
                });
            }
            // Cache tenant data
            tokenCache.setTenant(apiToken.tenantId, tenant);
        }
        // Clear validation cache on success
        validationCache.delete(cacheKey);
        // Attach tenant to request
        req.tenant = tenant;
        // Queue lastUsedAt update (fire and forget)
        executeQuery(() => db.apiToken.update({
            where: { id: apiToken.id },
            data: { lastUsedAt: new Date() },
            select: { id: true }
        }), { maxRetries: 1, timeout: 2000 }).catch(() => { }); // Ignore errors
        success = true;
        // Log slow queries
        const elapsed = Date.now() - startTime;
        if (elapsed > 500) {
            console.warn(`Slow auth: ${elapsed}ms for key ${apiKey.substring(0, 8)}...`);
        }
        next();
    }
    catch (error) {
        console.error('Auth error:', error);
        trackQuery(false);
        const elapsed = Date.now() - startTime;
        console.error(`Auth failed after ${elapsed}ms`);
        // Specific error handling
        if (error.code === 'P2024') {
            return res.status(503).json({
                error: "Connection pool exhausted. Please retry.",
                code: "POOL_EXHAUSTED",
                retry: true
            });
        }
        if (error.code === 'TIMEOUT' || error.message === 'Query timeout') {
            return res.status(504).json({
                error: "Authentication timeout",
                code: "TIMEOUT",
                retry: true
            });
        }
        if (error.code === 'P1001' || error.code === 'P1002') {
            return res.status(503).json({
                error: "Database connection failed",
                code: "DB_CONNECTION_FAILED",
                retry: true
            });
        }
        return res.status(500).json({
            error: "Authentication failed",
            code: "INTERNAL_ERROR"
        });
    }
    finally {
        trackQuery(success);
    }
};
// Get authentication statistics
export function getAuthStats() {
    return {
        cache: tokenCache.getStats(),
        validationCache: {
            size: validationCache.size,
            entries: Array.from(validationCache.keys()).map(k => k.split(':')[0].substring(0, 8) + '...')
        },
        config: {
            cacheTTL: CACHE_TTL,
            cacheMaxSize: CACHE_MAX_SIZE,
            validationCacheTTL: VALIDATION_CACHE_TTL
        }
    };
}
// Clear cache (for emergencies or testing)
export function clearAuthCache() {
    tokenCache.clear();
    validationCache.clear();
    console.log('Authentication cache cleared');
}
// Periodic cleanup of validation cache
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of validationCache.entries()) {
        if (now - value.timestamp > VALIDATION_CACHE_TTL) {
            validationCache.delete(key);
        }
    }
}, 30000); // Clean every 30 seconds
