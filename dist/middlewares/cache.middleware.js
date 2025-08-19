import { cache } from '../redis.js';
import crypto from 'crypto';
/**
 * Generate cache key from request
 */
function generateCacheKey(req) {
    const tenantId = req.tenant?.id || 'public';
    const method = req.method;
    const path = req.path;
    const query = JSON.stringify(req.query);
    const body = method !== 'GET' ? JSON.stringify(req.body) : '';
    // Create a hash of the request
    const hash = crypto
        .createHash('sha256')
        .update(`${method}:${path}:${query}:${body}`)
        .digest('hex')
        .substring(0, 16);
    return `cache:${tenantId}:${method}:${path}:${hash}`;
}
/**
 * Cache configuration for different endpoints
 */
const CACHE_CONFIG = {
    // Stream endpoints
    'GET:/stream/:streamId': { ttl: 30, tags: ['stream'] },
    'GET:/participant': { ttl: 30, tags: ['participant'] },
    'GET:/agenda/:streamId': { ttl: 30, tags: ['agenda'] },
    // Poll/Quiz results (shorter TTL for live data)
    'GET:/poll/:agendaId/results': { ttl: 10, tags: ['poll'] },
    'GET:/quiz/:agendaId/results': { ttl: 10, tags: ['quiz'] },
    // User data
    'GET:/user/:userWallet': { ttl: 60, tags: ['user'] },
    'GET:/user': { ttl: 60, tags: ['user'] },
    // Tenant info (longer TTL)
    'GET:/tenant/me': { ttl: 300, tags: ['tenant'] },
    'GET:/tenant/me/domains': { ttl: 300, tags: ['tenant', 'domain'] },
    // Default for other GET requests
    'GET:*': { ttl: 30, tags: ['general'] },
};
/**
 * Get cache configuration for endpoint
 */
function getCacheConfig(req) {
    const key = `${req.method}:${req.route?.path || req.path}`;
    // Check exact match first
    if (CACHE_CONFIG[key]) {
        return CACHE_CONFIG[key];
    }
    // Check wildcards
    const wildcardKey = `${req.method}:*`;
    if (CACHE_CONFIG[wildcardKey]) {
        return CACHE_CONFIG[wildcardKey];
    }
    // No caching for non-GET requests by default
    if (req.method !== 'GET') {
        return null;
    }
    return { ttl: 30, tags: ['general'] };
}
/**
 * Redis caching middleware
 */
export function cacheMiddleware(customTtl) {
    return async (req, res, next) => {
        // Skip caching for certain paths
        const skipPaths = ['/health', '/ready', '/monitor'];
        if (skipPaths.some(path => req.path.includes(path))) {
            return next();
        }
        // Skip if no-cache header is present
        if (req.headers['cache-control'] === 'no-cache') {
            return next();
        }
        const config = getCacheConfig(req);
        if (!config) {
            return next();
        }
        const cacheKey = generateCacheKey(req);
        const ttl = customTtl || config.ttl;
        try {
            // Try to get from cache
            const cached = await cache.get(cacheKey);
            if (cached) {
                // Add cache headers
                res.setHeader('X-Cache', 'HIT');
                res.setHeader('X-Cache-Key', cacheKey.substring(0, 20) + '...');
                // Send cached response
                return res.json(cached);
            }
            // Cache MISS - intercept response to cache it
            res.setHeader('X-Cache', 'MISS');
            // Store original json method
            const originalJson = res.json;
            // Override json method to cache response
            res.json = function (body) {
                // Don't cache error responses
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    // Cache the successful response with tags
                    cache.setWithTags(cacheKey, body, config.tags, ttl).catch(err => {
                        console.error('[Cache] Failed to cache response:', err);
                    });
                }
                // Call original json method
                return originalJson.call(this, body);
            };
            next();
        }
        catch (error) {
            console.error('[Cache] Middleware error:', error);
            next();
        }
    };
}
/**
 * Cache invalidation helper
 */
export class CacheInvalidator {
    /**
     * Invalidate cache by tags
     */
    static async invalidateByTags(tags) {
        await cache.invalidateByTags(tags);
    }
    /**
     * Invalidate cache by pattern
     */
    static async invalidateByPattern(pattern) {
        await cache.delPattern(pattern);
    }
    /**
     * Invalidate all cache for a tenant
     */
    static async invalidateTenant(tenantId) {
        await cache.delPattern(`cache:${tenantId}:*`);
    }
    /**
     * Invalidate stream-related cache
     */
    static async invalidateStream(streamId, tenantId) {
        await cache.delPattern(`cache:${tenantId}:*stream*${streamId}*`);
        await cache.invalidateByTags(['stream', 'participant', 'agenda']);
    }
    /**
     * Invalidate user-related cache
     */
    static async invalidateUser(wallet, tenantId) {
        await cache.delPattern(`cache:${tenantId}:*user*${wallet}*`);
        await cache.invalidateByTags(['user']);
    }
}
/**
 * Middleware to automatically invalidate cache on mutations
 */
export function cacheInvalidationMiddleware(req, res, next) {
    // Only invalidate on successful mutations
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const originalJson = res.json;
        res.json = function (body) {
            // Only invalidate on success
            if (res.statusCode >= 200 && res.statusCode < 300) {
                const tenantId = req.tenant?.id;
                if (tenantId) {
                    // Determine what to invalidate based on path
                    const path = req.path;
                    if (path.includes('/stream')) {
                        CacheInvalidator.invalidateStream(req.params.streamId || '', tenantId);
                    }
                    else if (path.includes('/user')) {
                        CacheInvalidator.invalidateUser(req.params.userWallet || req.body.wallet || '', tenantId);
                    }
                    else if (path.includes('/agenda')) {
                        CacheInvalidator.invalidateByTags(['agenda', 'poll', 'quiz']);
                    }
                    else if (path.includes('/participant')) {
                        CacheInvalidator.invalidateByTags(['participant']);
                    }
                    else if (path.includes('/tenant')) {
                        CacheInvalidator.invalidateTenant(tenantId);
                    }
                }
            }
            return originalJson.call(this, body);
        };
    }
    next();
}
