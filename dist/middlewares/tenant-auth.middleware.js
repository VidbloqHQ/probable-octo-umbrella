// import { Response, NextFunction } from "express";
// import * as bcrypt from "bcryptjs";
// import { db, executeQuery, trackQuery } from "../prisma.js";
// import { TenantRequest } from "../types/index.js";
import * as bcrypt from "bcryptjs";
import { db, executeQuery, trackQuery } from "../prisma.js";
// Cache configuration
const CACHE_TTL = parseInt(process.env.AUTH_CACHE_TTL || '300000'); // 5 minutes
const CACHE_MAX_SIZE = parseInt(process.env.AUTH_CACHE_MAX_SIZE || '500');
const UPDATE_BATCH_SIZE = parseInt(process.env.UPDATE_BATCH_SIZE || '5');
const UPDATE_INTERVAL = parseInt(process.env.UPDATE_INTERVAL || '15000'); // 15 seconds
// Simple but efficient LRU cache
class TokenCache {
    cache = new Map();
    hits = 0;
    misses = 0;
    maxSize;
    constructor(maxSize = CACHE_MAX_SIZE) {
        this.maxSize = maxSize;
    }
    get(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            this.misses++;
            return null;
        }
        if (Date.now() - entry.timestamp > CACHE_TTL) {
            this.cache.delete(key);
            this.misses++;
            return null;
        }
        // Move to end (LRU)
        this.cache.delete(key);
        this.cache.set(key, entry);
        this.hits++;
        return entry.data;
    }
    set(key, data) {
        // Enforce size limit
        if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) {
                this.cache.delete(firstKey);
            }
        }
        this.cache.set(key, { data, timestamp: Date.now() });
    }
    delete(key) {
        this.cache.delete(key);
    }
    clear() {
        this.cache.clear();
        this.hits = 0;
        this.misses = 0;
    }
    getStats() {
        const hitRate = (this.hits + this.misses) > 0
            ? this.hits / (this.hits + this.misses)
            : 0;
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            hits: this.hits,
            misses: this.misses,
            hitRate: (hitRate * 100).toFixed(2) + '%',
            ttl: CACHE_TTL
        };
    }
}
const tokenCache = new TokenCache();
// Batch update queue for lastUsedAt
class UpdateQueue {
    queue = new Map();
    timer = null;
    processing = false;
    add(tokenId) {
        this.queue.set(tokenId, new Date());
        if (!this.timer && !this.processing) {
            this.timer = setTimeout(() => this.flush(), UPDATE_INTERVAL);
        }
    }
    async flush() {
        if (this.processing || this.queue.size === 0) {
            this.timer = null;
            return;
        }
        this.processing = true;
        this.timer = null;
        const updates = Array.from(this.queue.entries());
        this.queue.clear();
        // Process in small batches to avoid connection pool exhaustion
        for (let i = 0; i < updates.length; i += UPDATE_BATCH_SIZE) {
            const batch = updates.slice(i, i + UPDATE_BATCH_SIZE);
            try {
                // Use individual updates instead of batch to avoid long-running transactions
                await Promise.allSettled(batch.map(([id, timestamp]) => executeQuery(() => db.apiToken.update({
                    where: { id },
                    data: { lastUsedAt: timestamp },
                    select: { id: true } // Minimize data transfer
                }), { maxRetries: 1, timeout: 5000 }).catch(err => {
                    console.error(`Failed to update lastUsedAt for ${id}:`, err.message);
                })));
                // Small delay between batches
                if (i + UPDATE_BATCH_SIZE < updates.length) {
                    await new Promise(r => setTimeout(r, 100));
                }
            }
            catch (error) {
                console.error('Batch update error:', error);
            }
        }
        this.processing = false;
        // Schedule next flush if items were added during processing
        if (this.queue.size > 0 && !this.timer) {
            this.timer = setTimeout(() => this.flush(), UPDATE_INTERVAL);
        }
    }
    getStats() {
        return {
            queueSize: this.queue.size,
            processing: this.processing,
            scheduled: !!this.timer
        };
    }
}
const updateQueue = new UpdateQueue();
// Request coalescing to prevent thundering herd
class RequestCoalescer {
    inFlight = new Map();
    async coalesce(key, fn) {
        // If there's already a request in flight for this key, wait for it
        const existing = this.inFlight.get(key);
        if (existing) {
            return existing;
        }
        // Start new request and store the promise
        const promise = fn().finally(() => {
            // Clean up after request completes
            this.inFlight.delete(key);
        });
        this.inFlight.set(key, promise);
        return promise;
    }
    getStats() {
        return {
            inFlightRequests: this.inFlight.size,
            keys: Array.from(this.inFlight.keys())
        };
    }
}
const requestCoalescer = new RequestCoalescer();
// Token validation cache (stores validation results temporarily)
const validationCache = new Map();
const VALIDATION_CACHE_TTL = 5000; // 5 seconds for failed attempts
/**
 * Optimized authentication middleware
 * CRITICAL: Skip authentication for OPTIONS requests to allow CORS preflight
 */
export const authenticateTenant = async (req, res, next) => {
    // CRITICAL: Skip authentication for OPTIONS requests (CORS preflight)
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
        // Try cache first
        const cached = tokenCache.get(cacheKey);
        if (cached) {
            req.tenant = cached.tenant;
            // Queue update (non-blocking)
            updateQueue.add(cached.tokenId);
            success = true;
            // Log if even cache hit is slow
            const elapsed = Date.now() - startTime;
            if (elapsed > 100) {
                console.warn(`Slow cache hit: ${elapsed}ms for key ${apiKey.substring(0, 8)}...`);
            }
            return next();
        }
        // Use request coalescing to prevent multiple DB queries for same key
        try {
            const result = await requestCoalescer.coalesce(cacheKey, async () => {
                // Check cache again in case another request populated it
                const recheckedCache = tokenCache.get(cacheKey);
                if (recheckedCache) {
                    return recheckedCache;
                }
                // OPTIMIZED: Split the query into two parts
                // First, do a lightweight query to validate the token
                const apiToken = await executeQuery(async () => {
                    return await db.apiToken.findUnique({
                        where: { key: apiKey },
                        select: {
                            id: true,
                            secret: true,
                            isActive: true,
                            expiresAt: true,
                            tenantId: true, // Just get the ID first
                        }
                    });
                }, {
                    maxRetries: 2,
                    timeout: 10000 // 10 second timeout
                });
                if (!apiToken) {
                    // Cache the failure
                    validationCache.set(cacheKey, { valid: false, timestamp: Date.now() });
                    throw new Error("INVALID_KEY");
                }
                if (!apiToken.isActive) {
                    validationCache.set(cacheKey, { valid: false, timestamp: Date.now() });
                    throw new Error("KEY_REVOKED");
                }
                if (apiToken.expiresAt && new Date(apiToken.expiresAt) < new Date()) {
                    validationCache.set(cacheKey, { valid: false, timestamp: Date.now() });
                    throw new Error("KEY_EXPIRED");
                }
                // Verify secret (this is CPU-bound, not I/O bound)
                const validSecret = await bcrypt.compare(apiSecret, apiToken.secret);
                if (!validSecret) {
                    validationCache.set(cacheKey, { valid: false, timestamp: Date.now() });
                    throw new Error("INVALID_SECRET");
                }
                // Only after validation passes, fetch the full tenant data
                const tenant = await executeQuery(async () => {
                    return await db.tenant.findUnique({
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
                    });
                }, {
                    maxRetries: 2,
                    timeout: 10000
                });
                if (!tenant) {
                    throw new Error("TENANT_NOT_FOUND");
                }
                // Prepare result for caching
                const cacheData = {
                    tokenId: apiToken.id,
                    tenant: tenant
                };
                // Cache successful authentication
                tokenCache.set(cacheKey, cacheData);
                // Clear validation cache on success
                validationCache.delete(cacheKey);
                return cacheData;
            });
            // Queue lastUsedAt update
            updateQueue.add(result.tokenId);
            // Attach tenant to request
            req.tenant = result.tenant;
            success = true;
            // Log slow queries
            const elapsed = Date.now() - startTime;
            if (elapsed > 1000) {
                console.warn(`Slow auth query: ${elapsed}ms for key ${apiKey.substring(0, 8)}...`);
            }
            next();
        }
        catch (error) {
            // Handle specific errors from coalescing
            if (error.message === 'INVALID_KEY') {
                return res.status(401).json({
                    error: "Invalid API key",
                    code: "INVALID_KEY"
                });
            }
            if (error.message === 'KEY_REVOKED') {
                return res.status(401).json({
                    error: "API key has been revoked",
                    code: "KEY_REVOKED"
                });
            }
            if (error.message === 'KEY_EXPIRED') {
                return res.status(401).json({
                    error: "API key has expired",
                    code: "KEY_EXPIRED"
                });
            }
            if (error.message === 'INVALID_SECRET') {
                return res.status(401).json({
                    error: "Invalid API credentials",
                    code: "INVALID_SECRET"
                });
            }
            if (error.message === 'TENANT_NOT_FOUND') {
                return res.status(404).json({
                    error: "Tenant not found",
                    code: "TENANT_NOT_FOUND"
                });
            }
            // Re-throw for outer catch block
            throw error;
        }
    }
    catch (error) {
        console.error('Auth error:', error);
        // Track failed query
        trackQuery(false);
        // Log the time even for failures
        const elapsed = Date.now() - startTime;
        console.error(`Auth failed after ${elapsed}ms for key ${req.headers["x-api-key"]?.toString().substring(0, 8)}...`);
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
        // Track query success/failure
        trackQuery(success);
    }
};
// Get authentication statistics
export function getAuthStats() {
    return {
        cache: tokenCache.getStats(),
        updateQueue: updateQueue.getStats(),
        requestCoalescer: requestCoalescer.getStats(),
        validationCache: {
            size: validationCache.size,
            entries: Array.from(validationCache.keys()).map(k => k.split(':')[0].substring(0, 8) + '...')
        },
        config: {
            cacheTTL: CACHE_TTL,
            cacheMaxSize: CACHE_MAX_SIZE,
            updateBatchSize: UPDATE_BATCH_SIZE,
            updateInterval: UPDATE_INTERVAL,
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
// Force flush update queue
export async function flushUpdateQueue() {
    await updateQueue.flush();
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
