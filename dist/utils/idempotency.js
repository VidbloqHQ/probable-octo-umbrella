// src/utils/idempotency.utils.ts
import { db, executeQuery } from "../prisma.js";
// In-memory cache for very recent operations (ultra-fast)
const recentOperations = new Map();
const MEMORY_CACHE_TTL = 5000; // 5 seconds
// Clean up memory cache periodically
const memoryCleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of recentOperations.entries()) {
        if (now - value.timestamp > MEMORY_CACHE_TTL) {
            recentOperations.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[Idempotency] Cleaned ${cleaned} expired memory cache entries`);
    }
}, 10000); // Every 10 seconds
/**
 * Generate a unique idempotency key for an operation
 * @param operation - The operation name (e.g., 'createStream', 'joinRoom')
 * @param tenantId - The tenant ID
 * @param params - Additional parameters to make the key unique
 * @returns A unique idempotency key
 */
export function generateIdempotencyKey(operation, tenantId, ...params) {
    // Convert all params to strings and filter out undefined/null
    const cleanParams = params
        .filter(p => p !== undefined && p !== null)
        .map(p => String(p));
    return `${operation}:${tenantId}:${cleanParams.join(':')}`;
}
/**
 * Generate idempotency key from request
 * Useful for extracting key from headers or generating from request body
 */
export function getRequestIdempotencyKey(req, operation) {
    // First check if client provided an idempotency key
    const headerKey = req.headers['idempotency-key'] ||
        req.headers['x-idempotency-key'];
    if (headerKey) {
        return String(headerKey);
    }
    // Generate one from request data
    const tenantId = req.tenant?.id;
    if (!tenantId) {
        return null;
    }
    // Create a deterministic key from request body
    const bodyHash = JSON.stringify(req.body || {});
    return generateIdempotencyKey(operation, tenantId, req.method, req.path, bodyHash.substring(0, 50) // Use first 50 chars of body
    );
}
/**
 * Ultra-fast idempotency check using memory first, then database
 * @param key - The idempotency key
 * @param operation - The async operation to execute
 * @param options - Cache options
 * @returns Object with cached flag and result
 */
export async function checkIdempotencyFast(key, operation, options = {}) {
    const { useMemoryCache = true, useDbCache = true, ttlMinutes = 5 } = options;
    // Step 1: Check memory cache first (instant, no DB query)
    if (useMemoryCache) {
        const memCached = recentOperations.get(key);
        if (memCached && Date.now() - memCached.timestamp < MEMORY_CACHE_TTL) {
            console.log(`[Idempotency] Memory cache hit for key: ${key.substring(0, 20)}...`);
            return { cached: true, result: memCached.result };
        }
    }
    // Step 2: Check database cache (only if needed)
    if (useDbCache) {
        try {
            const dbCached = await executeQuery(() => db.idempotencyKey.findUnique({
                where: { key },
                select: { response: true, expiresAt: true }
            }), { maxRetries: 1, timeout: 2000 });
            if (dbCached && dbCached.expiresAt > new Date()) {
                console.log(`[Idempotency] DB cache hit for key: ${key.substring(0, 20)}...`);
                // Store in memory cache for next time
                if (useMemoryCache) {
                    recentOperations.set(key, {
                        result: dbCached.response,
                        timestamp: Date.now()
                    });
                }
                return { cached: true, result: dbCached.response };
            }
        }
        catch (error) {
            console.error(`[Idempotency] Cache check failed for key ${key}:`, error);
            // Ignore cache check errors - proceed with operation
        }
    }
    // Step 3: Execute the actual operation
    console.log(`[Idempotency] Cache miss, executing operation for key: ${key.substring(0, 20)}...`);
    let result;
    try {
        result = await operation();
    }
    catch (error) {
        console.error(`[Idempotency] Operation failed for key ${key}:`, error);
        throw error; // Re-throw the error
    }
    // Step 4: Store in caches (fire and forget - don't block response)
    if (useMemoryCache) {
        recentOperations.set(key, { result, timestamp: Date.now() });
    }
    if (useDbCache) {
        // Don't await - fire and forget
        executeQuery(() => db.idempotencyKey.upsert({
            where: { key },
            update: {
                response: result,
                expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000)
            },
            create: {
                key,
                response: result,
                expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000)
            }
        }), { maxRetries: 1, timeout: 3000 }).catch(error => {
            console.error(`[Idempotency] Failed to store cache for key ${key}:`, error);
        });
    }
    return { cached: false, result };
}
/**
 * Check and store idempotency (full database version with strong consistency)
 * Use this for critical operations like payments
 * @param key - The idempotency key
 * @param operation - The async operation to execute
 * @param ttlMinutes - How long to cache the result
 * @returns Object with cached flag and result
 */
export async function checkAndStoreIdempotency(key, operation, ttlMinutes = 5) {
    // Check for existing idempotency key
    try {
        const existing = await executeQuery(() => db.idempotencyKey.findUnique({
            where: { key },
            select: { response: true, expiresAt: true }
        }), { maxRetries: 1, timeout: 2000 });
        if (existing && existing.expiresAt > new Date()) {
            console.log(`[Idempotency] Found existing result for key: ${key.substring(0, 20)}...`);
            return { cached: true, result: existing.response };
        }
    }
    catch (error) {
        console.error(`[Idempotency] Error checking existing key:`, error);
        // Continue - we'll try to execute the operation
    }
    // Execute operation
    let result;
    try {
        result = await operation();
    }
    catch (error) {
        console.error(`[Idempotency] Operation failed:`, error);
        throw error;
    }
    // Store idempotency key with retry logic
    try {
        await executeQuery(() => db.idempotencyKey.upsert({
            where: { key },
            update: {
                response: result,
                expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000)
            },
            create: {
                key,
                response: result,
                expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000)
            }
        }), { maxRetries: 2, timeout: 3000 });
        console.log(`[Idempotency] Stored result for key: ${key.substring(0, 20)}...`);
    }
    catch (error) {
        console.error(`[Idempotency] Failed to store idempotency key:`, error);
        // Still return the result even if we couldn't cache it
    }
    return { cached: false, result };
}
/**
 * Natural idempotency using database constraints (no extra queries!)
 * This is just a wrapper for clarity - the operation itself handles idempotency
 * @param operation - The naturally idempotent operation (like upsert)
 * @returns The operation result
 */
export async function naturalIdempotentOperation(operation) {
    // Just run the operation - relies on unique constraints
    return operation();
}
/**
 * Cleanup expired idempotency keys from database
 * @returns Number of keys deleted
 */
export async function cleanupExpiredIdempotencyKeys() {
    try {
        const result = await executeQuery(() => db.idempotencyKey.deleteMany({
            where: {
                expiresAt: {
                    lt: new Date()
                }
            }
        }), { maxRetries: 1, timeout: 5000 });
        if (result.count > 0) {
            console.log(`[Idempotency] Cleaned up ${result.count} expired keys`);
        }
        return result.count;
    }
    catch (error) {
        console.error("[Idempotency] Failed to cleanup expired keys:", error);
        return 0;
    }
}
/**
 * Force clear all idempotency caches (for testing or emergency)
 */
export function clearAllIdempotencyCaches() {
    recentOperations.clear();
    console.log("[Idempotency] Cleared all memory caches");
}
/**
 * Get cache statistics (for monitoring)
 */
export function getIdempotencyCacheStats() {
    let oldestTimestamp = null;
    for (const entry of recentOperations.values()) {
        if (oldestTimestamp === null || entry.timestamp < oldestTimestamp) {
            oldestTimestamp = entry.timestamp;
        }
    }
    return {
        memoryCacheSize: recentOperations.size,
        memoryCacheTTL: MEMORY_CACHE_TTL,
        oldestMemoryEntry: oldestTimestamp ? Date.now() - oldestTimestamp : null
    };
}
// Schedule database cleanup every hour
const dbCleanupInterval = setInterval(async () => {
    await cleanupExpiredIdempotencyKeys();
}, 3600000); // 1 hour
// Cleanup on process exit
process.on('SIGTERM', () => {
    clearInterval(memoryCleanupInterval);
    clearInterval(dbCleanupInterval);
});
process.on('SIGINT', () => {
    clearInterval(memoryCleanupInterval);
    clearInterval(dbCleanupInterval);
});
// Export everything
export default {
    generateIdempotencyKey,
    getRequestIdempotencyKey,
    checkIdempotencyFast,
    checkAndStoreIdempotency,
    naturalIdempotentOperation,
    cleanupExpiredIdempotencyKeys,
    clearAllIdempotencyCaches,
    getIdempotencyCacheStats
};
