import { RateLimiterRedis } from 'rate-limiter-flexible';
import { redisClient } from '../redis.js';
// Different rate limit tiers
const RATE_LIMIT_TIERS = {
    // Critical endpoints that hit database directly
    critical: {
        points: 10, // Number of requests
        duration: 60, // Per 60 seconds
        blockDuration: 60, // Block for 60 seconds if exceeded
    },
    // Standard API endpoints
    standard: {
        points: 30,
        duration: 60,
        blockDuration: 30,
    },
    // Read-heavy endpoints
    read: {
        points: 60,
        duration: 60,
        blockDuration: 15,
    },
    // Public endpoints
    public: {
        points: 20,
        duration: 60,
        blockDuration: 60,
    },
    // Auth endpoints (stricter to prevent brute force)
    auth: {
        points: 5,
        duration: 60,
        blockDuration: 300, // 5 minutes
    },
    // Stream creation (expensive operation)
    streamCreate: {
        points: 5,
        duration: 300, // 5 per 5 minutes
        blockDuration: 300,
    },
    // Bulk operations
    bulk: {
        points: 3,
        duration: 60,
        blockDuration: 120,
    }
};
// Create rate limiters for each tier
const rateLimiters = {};
// Initialize rate limiters
Object.entries(RATE_LIMIT_TIERS).forEach(([tier, config]) => {
    rateLimiters[tier] = new RateLimiterRedis({
        storeClient: redisClient,
        keyPrefix: `rl:${tier}:`,
        points: config.points,
        duration: config.duration,
        blockDuration: config.blockDuration,
        execEvenly: true, // Spread requests evenly
    });
});
// Global rate limiter (across all endpoints)
const globalRateLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:global:',
    points: 100, // 100 requests
    duration: 60, // per minute
    blockDuration: 60,
});
// Tenant-specific rate limiter
const tenantRateLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:tenant:',
    points: 500, // 500 requests per tenant
    duration: 60, // per minute
    blockDuration: 30,
});
// Connection pool protection limiter (most critical)
const connectionPoolLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:pool:',
    points: 20, // Max 20 concurrent database operations
    duration: 1, // per second
    blockDuration: 5,
});
/**
 * Get client identifier for rate limiting
 */
function getClientId(req) {
    // Try to get tenant ID first
    const tenantReq = req;
    if (tenantReq.tenant?.id) {
        return `tenant:${tenantReq.tenant.id}`;
    }
    // Fall back to API key if available
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
        return `key:${apiKey.substring(0, 16)}`; // Use first 16 chars
    }
    // Fall back to IP address
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    return `ip:${ip}`;
}
/**
 * Determine rate limit tier based on endpoint
 */
function getRateLimitTier(req) {
    const path = req.path;
    const method = req.method;
    // Auth endpoints
    if (path.includes('/tenant') && method === 'POST') {
        return 'auth';
    }
    // Stream creation
    if (path.includes('/stream') && method === 'POST') {
        return 'streamCreate';
    }
    // Bulk operations
    if (path.includes('/bulk') || (req.body && Array.isArray(req.body) && req.body.length > 10)) {
        return 'bulk';
    }
    // Critical database operations
    if (method === 'DELETE' || method === 'PUT' || method === 'PATCH') {
        return 'critical';
    }
    // Read operations
    if (method === 'GET') {
        return 'read';
    }
    // Public endpoints
    if (path.includes('/health') || path.includes('/ready')) {
        return 'public';
    }
    return 'standard';
}
/**
 * Rate limiting middleware factory
 */
export function createRateLimiter(tier) {
    return async (req, res, next) => {
        try {
            const clientId = getClientId(req);
            const rateLimitTier = tier || getRateLimitTier(req);
            const limiter = rateLimiters[rateLimitTier] || rateLimiters.standard;
            // Check multiple rate limits in parallel
            const promises = [
                limiter.consume(clientId, 1),
                globalRateLimiter.consume(clientId, 1),
            ];
            // Add tenant limiter if tenant is identified
            const tenantReq = req;
            if (tenantReq.tenant?.id) {
                promises.push(tenantRateLimiter.consume(tenantReq.tenant.id, 1));
            }
            // Add connection pool protection for database operations
            const path = req.path;
            if (!path.includes('/health') && !path.includes('/ready')) {
                promises.push(connectionPoolLimiter.consume('global', 1));
            }
            const results = await Promise.all(promises);
            // Add rate limit headers
            const result = results[0]; // Use tier-specific result for headers
            res.setHeader('X-RateLimit-Limit', String(limiter.points));
            res.setHeader('X-RateLimit-Remaining', String(result.remainingPoints));
            res.setHeader('X-RateLimit-Reset', new Date(Date.now() + result.msBeforeNext).toISOString());
            next();
        }
        catch (error) {
            if (error instanceof Error) {
                // Rate limit exceeded
                const retryAfter = Math.round(error.msBeforeNext / 1000) || 60;
                res.setHeader('Retry-After', String(retryAfter));
                res.setHeader('X-RateLimit-Limit', String(error.points || 0));
                res.setHeader('X-RateLimit-Remaining', '0');
                res.setHeader('X-RateLimit-Reset', new Date(Date.now() + error.msBeforeNext).toISOString());
                // Log for monitoring
                console.warn(`[RateLimit] Limit exceeded for ${getClientId(req)} on ${req.path}`);
                return res.status(429).json({
                    error: 'Too many requests',
                    message: `Rate limit exceeded. Please retry after ${retryAfter} seconds.`,
                    retryAfter,
                    code: 'RATE_LIMIT_EXCEEDED'
                });
            }
            // Redis connection error - allow request through but log
            console.error('[RateLimit] Redis error:', error);
            next();
        }
    };
}
/**
 * Sliding window rate limiter for specific operations
 */
export class SlidingWindowRateLimiter {
    keyPrefix;
    windowSize;
    limit;
    constructor(keyPrefix, windowSizeSeconds, limit) {
        this.keyPrefix = keyPrefix;
        this.windowSize = windowSizeSeconds;
        this.limit = limit;
    }
    async checkLimit(identifier) {
        const now = Date.now();
        const windowStart = now - (this.windowSize * 1000);
        const key = `${this.keyPrefix}:${identifier}`;
        try {
            // Remove old entries
            await redisClient.zremrangebyscore(key, 0, windowStart);
            // Count current entries
            const count = await redisClient.zcard(key);
            if (count >= this.limit) {
                return false;
            }
            // Add current request
            await redisClient.zadd(key, now, `${now}:${Math.random()}`);
            await redisClient.expire(key, this.windowSize);
            return true;
        }
        catch (error) {
            console.error('[SlidingWindowRateLimiter] Error:', error);
            return true; // Allow on error
        }
    }
}
/**
 * Circuit breaker for database operations
 */
export class CircuitBreaker {
    threshold;
    timeout;
    resetTimeout;
    failures = new Map();
    lastFailureTime = new Map();
    state = new Map();
    constructor(threshold = 5, timeout = 60000, // 1 minute
    resetTimeout = 30000 // 30 seconds
    ) {
        this.threshold = threshold;
        this.timeout = timeout;
        this.resetTimeout = resetTimeout;
    }
    async execute(key, operation) {
        const currentState = this.state.get(key) || 'closed';
        if (currentState === 'open') {
            const lastFailure = this.lastFailureTime.get(key) || 0;
            if (Date.now() - lastFailure > this.resetTimeout) {
                this.state.set(key, 'half-open');
            }
            else {
                throw new Error(`Circuit breaker is open for ${key}`);
            }
        }
        try {
            const result = await operation();
            if (currentState === 'half-open') {
                this.reset(key);
            }
            return result;
        }
        catch (error) {
            this.recordFailure(key);
            throw error;
        }
    }
    recordFailure(key) {
        const failures = (this.failures.get(key) || 0) + 1;
        this.failures.set(key, failures);
        this.lastFailureTime.set(key, Date.now());
        if (failures >= this.threshold) {
            this.state.set(key, 'open');
            console.error(`[CircuitBreaker] Opened for ${key} after ${failures} failures`);
        }
    }
    reset(key) {
        this.failures.delete(key);
        this.lastFailureTime.delete(key);
        this.state.set(key, 'closed');
        console.log(`[CircuitBreaker] Reset for ${key}`);
    }
    getState(key) {
        return this.state.get(key) || 'closed';
    }
}
// Export circuit breaker instance
export const dbCircuitBreaker = new CircuitBreaker(5, 60000, 30000);
// Export rate limiter instances for direct use
export { rateLimiters, globalRateLimiter, tenantRateLimiter, connectionPoolLimiter };
