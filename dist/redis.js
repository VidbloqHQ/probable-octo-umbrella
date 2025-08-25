import Redis from 'ioredis';
// Redis Cloud configuration from your dashboard
const REDIS_CONFIG = {
    // host: process.env.REDIS_HOST || 'redis-12652.c341.af-south-1-1.ec2.redns.redis-cloud.com',
    // port: parseInt(process.env.REDIS_PORT || '12652'),
    // username: process.env.REDIS_USERNAME || 'default',
    // password: process.env.REDIS_PASSWORD || '', // You need to add your actual password
    host: process.env.REDIS_HOST || 'redis-10683.c256.us-east-1-2.ec2.redns.redis-cloud.com',
    port: parseInt(process.env.REDIS_PORT || '10683'),
    username: process.env.REDIS_USERNAME || 'default',
    password: process.env.REDIS_PASSWORD || '', // You need to add your actual password
};
// Check if Redis is configured
const REDIS_ENABLED = !!(REDIS_CONFIG.host && REDIS_CONFIG.port);
// Create Redis client with error handling
let redisClient;
let redisSubscriber;
let redisAvailable = false;
if (REDIS_ENABLED) {
    // Create Redis client using ioredis (better for production)
    redisClient = new Redis({
        host: REDIS_CONFIG.host,
        port: REDIS_CONFIG.port,
        username: REDIS_CONFIG.username,
        password: REDIS_CONFIG.password,
        retryStrategy: (times) => {
            if (times > 10) {
                console.error('Redis: Max retry attempts reached, giving up');
                return null;
            }
            const delay = Math.min(times * 50, 2000);
            return delay;
        },
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        connectTimeout: 10000,
        keepAlive: 30000,
        noDelay: true,
        lazyConnect: false,
    });
    // Create a separate client for pub/sub if needed
    redisSubscriber = new Redis({
        host: REDIS_CONFIG.host,
        port: REDIS_CONFIG.port,
        username: REDIS_CONFIG.username,
        password: REDIS_CONFIG.password,
    });
    // Error handling
    redisClient.on('error', (err) => {
        if (!err.message?.includes('ECONNREFUSED') || redisAvailable) {
            console.error('Redis Client Error:', err.message);
        }
        redisAvailable = false;
    });
    redisClient.on('connect', () => {
        console.log('✅ Redis connected successfully to', REDIS_CONFIG.host);
        redisAvailable = true;
    });
    redisClient.on('ready', () => {
        console.log('✅ Redis client ready');
        redisAvailable = true;
    });
    redisClient.on('close', () => {
        if (redisAvailable) {
            console.log('Redis connection closed');
        }
        redisAvailable = false;
    });
}
else {
    // Create dummy clients that do nothing
    console.warn('⚠️ Redis not configured - app will run without rate limiting and caching');
    redisClient = new Proxy({}, {
        get: () => () => Promise.resolve(null)
    });
    redisSubscriber = redisClient;
}
// Redis health check
export async function isRedisHealthy() {
    if (!REDIS_ENABLED || !redisAvailable) {
        return false;
    }
    try {
        const result = await redisClient.ping();
        return result === 'PONG';
    }
    catch (error) {
        return false;
    }
}
// Graceful shutdown
export async function closeRedisConnection() {
    if (!REDIS_ENABLED || !redisAvailable) {
        return;
    }
    try {
        await redisClient.quit();
        await redisSubscriber.quit();
        console.log('Redis connections closed gracefully');
    }
    catch (error) {
        console.error('Error closing Redis connections:', error);
    }
}
// Cache helpers with automatic serialization - with fallback when Redis is not available
export const cache = {
    async get(key) {
        if (!redisAvailable)
            return null;
        try {
            const data = await redisClient.get(key);
            return data ? JSON.parse(data) : null;
        }
        catch (error) {
            return null;
        }
    },
    async set(key, value, ttlSeconds) {
        if (!redisAvailable)
            return false;
        try {
            const serialized = JSON.stringify(value);
            if (ttlSeconds) {
                await redisClient.setex(key, ttlSeconds, serialized);
            }
            else {
                await redisClient.set(key, serialized);
            }
            return true;
        }
        catch (error) {
            return false;
        }
    },
    async del(key) {
        if (!redisAvailable)
            return 0;
        try {
            // Handle both string and string array
            if (Array.isArray(key)) {
                return await redisClient.del(...key);
            }
            else {
                return await redisClient.del(key);
            }
        }
        catch (error) {
            return 0;
        }
    },
    async exists(key) {
        if (!redisAvailable)
            return false;
        try {
            const result = await redisClient.exists(key);
            return result === 1;
        }
        catch (error) {
            return false;
        }
    },
    async ttl(key) {
        if (!redisAvailable)
            return -1;
        try {
            return await redisClient.ttl(key);
        }
        catch (error) {
            return -1;
        }
    },
    async delPattern(pattern) {
        if (!redisAvailable)
            return 0;
        try {
            const keys = await redisClient.keys(pattern);
            if (keys.length === 0)
                return 0;
            return await redisClient.del(...keys);
        }
        catch (error) {
            return 0;
        }
    },
    async invalidateByTags(tags) {
        if (!redisAvailable)
            return;
        try {
            const pipeline = redisClient.pipeline();
            for (const tag of tags) {
                const keys = await redisClient.smembers(`tag:${tag}`);
                if (keys.length > 0) {
                    pipeline.del(...keys);
                    pipeline.del(`tag:${tag}`);
                }
            }
            await pipeline.exec();
        }
        catch (error) {
            // Silently fail
        }
    },
    async setWithTags(key, value, tags, ttlSeconds) {
        if (!redisAvailable)
            return false;
        try {
            const pipeline = redisClient.pipeline();
            const serialized = JSON.stringify(value);
            if (ttlSeconds) {
                pipeline.setex(key, ttlSeconds, serialized);
            }
            else {
                pipeline.set(key, serialized);
            }
            for (const tag of tags) {
                pipeline.sadd(`tag:${tag}`, key);
                if (ttlSeconds) {
                    pipeline.expire(`tag:${tag}`, ttlSeconds);
                }
            }
            await pipeline.exec();
            return true;
        }
        catch (error) {
            return false;
        }
    }
};
// Export flag to check if Redis is available
export function isRedisAvailable() {
    return redisAvailable;
}
// Export clients
export { redisClient, redisSubscriber };
