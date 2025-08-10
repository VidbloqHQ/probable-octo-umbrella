import { Response, NextFunction } from "express";
import * as bcrypt from "bcryptjs";
import { db, executeQuery, trackQuery } from "../prisma.js";
import { TenantRequest } from "../types/index.js";

// Cache configuration
const CACHE_TTL = parseInt(process.env.AUTH_CACHE_TTL || '300000'); // 5 minutes
const CACHE_MAX_SIZE = parseInt(process.env.AUTH_CACHE_MAX_SIZE || '500'); // Reduced for Railway
const UPDATE_BATCH_SIZE = parseInt(process.env.UPDATE_BATCH_SIZE || '5'); // Smaller batches
const UPDATE_INTERVAL = parseInt(process.env.UPDATE_INTERVAL || '15000'); // 15 seconds

// Simple but efficient LRU cache
class TokenCache {
  private cache = new Map<string, { data: any; timestamp: number }>();
  private hits = 0;
  private misses = 0;
  private maxSize: number;
  
  constructor(maxSize: number = CACHE_MAX_SIZE) {
    this.maxSize = maxSize;
  }
  
  get(key: string): any | null {
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
  
  set(key: string, data: any): void {
    // Enforce size limit
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }
    
    this.cache.set(key, { data, timestamp: Date.now() });
  }
  
  delete(key: string): void {
    this.cache.delete(key);
  }
  
  clear(): void {
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
  private queue = new Map<string, Date>();
  private timer: NodeJS.Timeout | null = null;
  private processing = false;
  
  add(tokenId: string): void {
    this.queue.set(tokenId, new Date());
    
    if (!this.timer && !this.processing) {
      this.timer = setTimeout(() => this.flush(), UPDATE_INTERVAL);
    }
  }
  
  async flush(): Promise<void> {
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
        await Promise.allSettled(
          batch.map(([id, timestamp]) =>
            executeQuery(
              () => db.apiToken.update({
                where: { id },
                data: { lastUsedAt: timestamp },
                select: { id: true } // Minimize data transfer
              }),
              { maxRetries: 1, timeout: 5000 }
            ).catch(err => {
              console.error(`Failed to update lastUsedAt for ${id}:`, err.message);
            })
          )
        );
        
        // Small delay between batches
        if (i + UPDATE_BATCH_SIZE < updates.length) {
          await new Promise(r => setTimeout(r, 100));
        }
      } catch (error) {
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

/**
 * Optimized authentication middleware for Prisma 6.5.0
 */
export const authenticateTenant = async (
  req: TenantRequest,
  res: Response,
  next: NextFunction
) => {
  const startTime = Date.now();
  let success = false;
  
  try {
    const apiKey = req.headers["x-api-key"] as string;
    const apiSecret = req.headers["x-api-secret"] as string;

    if (!apiKey || !apiSecret) {
      return res.status(401).json({ 
        error: "API credentials required",
        code: "MISSING_CREDENTIALS"
      });
    }

    // Try cache first
    const cacheKey = `${apiKey}:${apiSecret}`;
    const cached = tokenCache.get(cacheKey);
    
    if (cached) {
      req.tenant = cached.tenant;
      
      // Queue update (non-blocking)
      updateQueue.add(cached.tokenId);
      
      success = true;
      return next();
    }

    // Cache miss - query database
    // Note: Using findUnique with Prisma 6.5.0 should work fine
    const apiToken = await executeQuery(
      async () => {
        return await db.apiToken.findUnique({
          where: { key: apiKey },
          select: {
            id: true,
            secret: true,
            isActive: true,
            expiresAt: true,
            tenant: {
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
            }
          }
        });
      },
      { maxRetries: 2, timeout: 10000 }
    );

    if (!apiToken) {
      return res.status(401).json({ 
        error: "Invalid API key",
        code: "INVALID_KEY"
      });
    }

    if (!apiToken.isActive) {
      return res.status(401).json({ 
        error: "API key has been revoked",
        code: "KEY_REVOKED"
      });
    }

    if (apiToken.expiresAt && new Date(apiToken.expiresAt) < new Date()) {
      return res.status(401).json({ 
        error: "API key has expired",
        code: "KEY_EXPIRED"
      });
    }

    // Verify secret
    const validSecret = await bcrypt.compare(apiSecret, apiToken.secret);
    
    if (!validSecret) {
      return res.status(401).json({ 
        error: "Invalid API credentials",
        code: "INVALID_SECRET"
      });
    }

    // Cache successful authentication
    tokenCache.set(cacheKey, {
      tokenId: apiToken.id,
      tenant: apiToken.tenant
    });

    // Queue lastUsedAt update
    updateQueue.add(apiToken.id);

    // Attach tenant to request
    req.tenant = apiToken.tenant;
    
    success = true;
    
    // Log slow queries in development
    const elapsed = Date.now() - startTime;
    if (elapsed > 1000) {
      console.warn(`Slow auth query: ${elapsed}ms for key ${apiKey.substring(0, 8)}...`);
    }
    
    next();
  } catch (error: any) {
    console.error('Auth error:', error);
    
    // Track failed query
    trackQuery(false);
    
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
  } finally {
    // Track query success/failure
    trackQuery(success);
  }
};

// Get authentication statistics
export function getAuthStats() {
  return {
    cache: tokenCache.getStats(),
    updateQueue: updateQueue.getStats(),
    config: {
      cacheTTL: CACHE_TTL,
      cacheMaxSize: CACHE_MAX_SIZE,
      updateBatchSize: UPDATE_BATCH_SIZE,
      updateInterval: UPDATE_INTERVAL
    }
  };
}

// Clear cache (for emergencies or testing)
export function clearAuthCache() {
  tokenCache.clear();
  console.log('Authentication cache cleared');
}

// Force flush update queue
export async function flushUpdateQueue() {
  await updateQueue.flush();
}