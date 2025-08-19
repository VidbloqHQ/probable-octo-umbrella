import Redis from 'ioredis';

// Redis connection configuration
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  db: parseInt(process.env.REDIS_DB || '0'),
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  connectTimeout: 10000,
  lazyConnect: false,
  keepAlive: 30000,
  noDelay: true,
};

// Create Redis client with error handling
export const redisClient = new Redis(redisConfig);

// Create a separate client for pub/sub if needed
export const redisSubscriber = new Redis(redisConfig);

// Redis health check
export async function isRedisHealthy(): Promise<boolean> {
  try {
    const result = await redisClient.ping();
    return result === 'PONG';
  } catch (error) {
    console.error('Redis health check failed:', error);
    return false;
  }
}

// Error handling
redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err);
});

redisClient.on('connect', () => {
  console.log('✅ Redis connected successfully');
});

redisClient.on('ready', () => {
  console.log('✅ Redis client ready');
});

redisClient.on('close', () => {
  console.log('Redis connection closed');
});

redisClient.on('reconnecting', (delay: number) => {
  console.log(`Redis reconnecting in ${delay}ms`);
});

// Graceful shutdown
export async function closeRedisConnection() {
  try {
    await redisClient.quit();
    await redisSubscriber.quit();
    console.log('Redis connections closed gracefully');
  } catch (error) {
    console.error('Error closing Redis connections:', error);
  }
}

// Cache helpers with automatic serialization
export const cache = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await redisClient.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error(`Cache get error for key ${key}:`, error);
      return null;
    }
  },

  async set(key: string, value: any, ttlSeconds?: number): Promise<boolean> {
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds) {
        await redisClient.setex(key, ttlSeconds, serialized);
      } else {
        await redisClient.set(key, serialized);
      }
      return true;
    } catch (error) {
      console.error(`Cache set error for key ${key}:`, error);
      return false;
    }
  },

  async del(key: string | string[]): Promise<number> {
    try {
      if (Array.isArray(key)) {
        return await redisClient.del(...key);
      } else {
        return await redisClient.del(key);
      }
    } catch (error) {
      console.error(`Cache delete error:`, error);
      return 0;
    }
  },

  async exists(key: string): Promise<boolean> {
    try {
      const result = await redisClient.exists(key);
      return result === 1;
    } catch (error) {
      console.error(`Cache exists error for key ${key}:`, error);
      return false;
    }
  },

  async ttl(key: string): Promise<number> {
    try {
      return await redisClient.ttl(key);
    } catch (error) {
      console.error(`Cache ttl error for key ${key}:`, error);
      return -1;
    }
  },

  // Pattern-based deletion (use with caution)
  async delPattern(pattern: string): Promise<number> {
    try {
      const keys = await redisClient.keys(pattern);
      if (keys.length === 0) return 0;
      return await redisClient.del(...keys);
    } catch (error) {
      console.error(`Cache delete pattern error:`, error);
      return 0;
    }
  },

  // Invalidate cache by tags
  async invalidateByTags(tags: string[]): Promise<void> {
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
    } catch (error) {
      console.error('Cache invalidation by tags error:', error);
    }
  },

  // Set with tags for easy invalidation
  async setWithTags(key: string, value: any, tags: string[], ttlSeconds?: number): Promise<boolean> {
    try {
      const pipeline = redisClient.pipeline();
      const serialized = JSON.stringify(value);
      
      if (ttlSeconds) {
        pipeline.setex(key, ttlSeconds, serialized);
      } else {
        pipeline.set(key, serialized);
      }
      
      // Add key to tag sets
      for (const tag of tags) {
        pipeline.sadd(`tag:${tag}`, key);
        if (ttlSeconds) {
          pipeline.expire(`tag:${tag}`, ttlSeconds);
        }
      }
      
      await pipeline.exec();
      return true;
    } catch (error) {
      console.error(`Cache setWithTags error for key ${key}:`, error);
      return false;
    }
  }
};