import { Response, NextFunction } from "express";
import * as bcrypt from "bcryptjs";
import { db, executeQuery, trackQuery } from "../prisma.js";
import { TenantRequest } from "../types/index.js";

// Cache configuration
const CACHE_TTL = parseInt(process.env.AUTH_CACHE_TTL || '300000'); // 5 minutes
const CACHE_MAX_SIZE = parseInt(process.env.AUTH_CACHE_MAX_SIZE || '1000'); // Increased size

// Combined cache entry for complete auth data
interface AuthCacheEntry {
  apiToken: {
    id: string;
    secret: string;
    isActive: boolean;
    expiresAt: Date | null;
    tenantId: string;
  };
  tenant: any;
  timestamp: number;
  secretVerified?: boolean; // Cache whether secret was already verified
}

// Ultra-fast combined cache
class UltraAuthCache {
  private cache = new Map<string, AuthCacheEntry>();
  private secretCache = new Map<string, boolean>(); // Cache bcrypt results
  private hits = 0;
  private misses = 0;
  
  get(apiKey: string, apiSecret: string): AuthCacheEntry | null {
    const entry = this.cache.get(apiKey);
    if (!entry) {
      this.misses++;
      return null;
    }
    
    if (Date.now() - entry.timestamp > CACHE_TTL) {
      this.cache.delete(apiKey);
      this.misses++;
      return null;
    }
    
    // Check if we've already verified this exact secret
    const secretKey = `${apiKey}:${apiSecret}`;
    if (this.secretCache.has(secretKey)) {
      if (this.secretCache.get(secretKey)) {
        this.hits++;
        return { ...entry, secretVerified: true };
      } else {
        // Secret is cached as invalid
        return null;
      }
    }
    
    this.hits++;
    return entry;
  }
  
  set(apiKey: string, entry: AuthCacheEntry): void {
    // Enforce size limit
    if (this.cache.size >= CACHE_MAX_SIZE) {
      // Remove oldest entries (first 10%)
      const toRemove = Math.ceil(CACHE_MAX_SIZE * 0.1);
      const keys = Array.from(this.cache.keys()).slice(0, toRemove);
      keys.forEach(key => this.cache.delete(key));
    }
    
    this.cache.set(apiKey, entry);
  }
  
  setSecretVerification(apiKey: string, apiSecret: string, isValid: boolean): void {
    const secretKey = `${apiKey}:${apiSecret}`;
    // Limit secret cache size
    if (this.secretCache.size >= 500) {
      // Clear oldest 50 entries
      const keys = Array.from(this.secretCache.keys()).slice(0, 50);
      keys.forEach(key => this.secretCache.delete(key));
    }
    this.secretCache.set(secretKey, isValid);
  }
  
  clear(): void {
    this.cache.clear();
    this.secretCache.clear();
    this.hits = 0;
    this.misses = 0;
  }
  
  getStats() {
    const hitRate = (this.hits + this.misses) > 0 
      ? this.hits / (this.hits + this.misses) 
      : 0;
      
    return {
      cacheSize: this.cache.size,
      secretCacheSize: this.secretCache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: (hitRate * 100).toFixed(2) + '%',
      ttl: CACHE_TTL
    };
  }
}

const authCache = new UltraAuthCache();

// Pre-warm cache on startup (for frequently used keys)
async function prewarmCache() {
  try {
    // Get recently used API keys
    const recentTokens = await executeQuery(
      () => db.apiToken.findMany({
        where: {
          isActive: true,
          lastUsedAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
          }
        },
        select: {
          id: true,
          key: true,
          secret: true,
          isActive: true,
          expiresAt: true,
          tenantId: true,
        },
        take: 50 // Pre-warm top 50 keys
      }),
      { maxRetries: 1, timeout: 5000 }
    );

    if (recentTokens.length > 0) {
      // Get tenant data for these tokens
      const tenantIds = [...new Set(recentTokens.map(t => t.tenantId))];
      const tenants = await executeQuery(
        () => db.tenant.findMany({
          where: {
            id: { in: tenantIds }
          },
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
            webhookUrl: true,        // ← add
            webhookSecret: true, 
            defaultFundingType: true,
          }
        }),
        { maxRetries: 1, timeout: 5000 }
      );

      const tenantMap = new Map(tenants.map(t => [t.id, t]));

      // Pre-populate cache
      recentTokens.forEach(token => {
        const tenant = tenantMap.get(token.tenantId);
        if (tenant) {
          authCache.set(token.key, {
            apiToken: {
              id: token.id,
              secret: token.secret,
              isActive: token.isActive,
              expiresAt: token.expiresAt,
              tenantId: token.tenantId,
            },
            tenant,
            timestamp: Date.now()
          });
        }
      });

     // console.log(`[Auth] Pre-warmed cache with ${recentTokens.length} frequently used API keys`);
    }
  } catch (error) {
    console.error("[Auth] Failed to pre-warm cache:", error);
  }
}

// Pre-warm cache on startup
setTimeout(prewarmCache, 3000); // Delay to ensure DB is ready

// Refresh cache periodically for active keys
setInterval(prewarmCache, 60000); // Every minute

/**
 * ULTRA-OPTIMIZED authentication middleware
 */
export const authenticateTenant = async (
  req: TenantRequest,
  res: Response,
  next: NextFunction
) => {
  // Skip authentication for OPTIONS requests (CORS preflight)
  if (req.method === 'OPTIONS') {
    return next();
  }
  
  const startTime = Date.now();
  // console.log(`[AUTH] Starting authentication`);
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

    // STEP 1: Check combined cache
    let cacheEntry = authCache.get(apiKey, apiSecret);
    
    if (cacheEntry) {
      // Cache hit!
      if (cacheEntry.secretVerified) {
        // Secret already verified in cache
        req.tenant = cacheEntry.tenant;
        success = true;
        
        const elapsed = Date.now() - startTime;
        if (elapsed > 100) {
          // console.log(`[Auth] Cache hit but slow: ${elapsed}ms`);
        }
        
        // Update lastUsedAt asynchronously (fire and forget)
        executeQuery(
          () => db.apiToken.update({
            where: { id: cacheEntry!.apiToken.id },
            data: { lastUsedAt: new Date() },
            select: { id: true }
          }),
          { maxRetries: 1, timeout: 2000 }
        ).catch(() => {});
         // console.log(`[AUTH] Authentication completed in ${Date.now() - startTime}ms`);

        return next();
      }
      
      // Cache hit but secret not verified yet
      const validSecret = await bcrypt.compare(apiSecret, cacheEntry.apiToken.secret);
      authCache.setSecretVerification(apiKey, apiSecret, validSecret);
      
      if (validSecret) {
        req.tenant = cacheEntry.tenant;
        success = true;
        
        const elapsed = Date.now() - startTime;
        if (elapsed > 100) {
          // console.log(`[Auth] Partial cache hit but slow: ${elapsed}ms`);
        }
        
        // Update lastUsedAt asynchronously
        executeQuery(
          () => db.apiToken.update({
            where: { id: cacheEntry!.apiToken.id },
            data: { lastUsedAt: new Date() },
            select: { id: true }
          }),
          { maxRetries: 1, timeout: 2000 }
        ).catch(() => {});
        
        return next();
      } else {
        return res.status(401).json({ 
          error: "Invalid API credentials",
          code: "INVALID_SECRET"
        });
      }
    }

    // STEP 2: Cache miss - fetch everything in one query using a join
    const result = await executeQuery(
      () => db.apiToken.findUnique({
        where: { key: apiKey },
        select: {
          id: true,
          secret: true,
          isActive: true,
          expiresAt: true,
          tenantId: true,
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
              webhookUrl: true,        // ← add
              webhookSecret: true, 
            }
          }
        }
      }),
      { 
        maxRetries: 1,
        timeout: 2000
      }
    );

    if (!result) {
      return res.status(401).json({ 
        error: "Invalid API key",
        code: "INVALID_KEY"
      });
    }

    // Validate token status
    if (!result.isActive) {
      return res.status(401).json({ 
        error: "API key has been revoked",
        code: "KEY_REVOKED"
      });
    }

    if (result.expiresAt && new Date(result.expiresAt) < new Date()) {
      return res.status(401).json({ 
        error: "API key has expired",
        code: "KEY_EXPIRED"
      });
    }

    if (!result.tenant) {
      return res.status(404).json({ 
        error: "Tenant not found",
        code: "TENANT_NOT_FOUND"
      });
    }

    // STEP 3: Verify secret
    const validSecret = await bcrypt.compare(apiSecret, result.secret);
    
    if (!validSecret) {
      return res.status(401).json({ 
        error: "Invalid API credentials",
        code: "INVALID_SECRET"
      });
    }

    // Cache the result
    authCache.set(apiKey, {
      apiToken: {
        id: result.id,
        secret: result.secret,
        isActive: result.isActive,
        expiresAt: result.expiresAt,
        tenantId: result.tenantId,
      },
      tenant: result.tenant,
      timestamp: Date.now()
    });
    
    // Cache the secret verification
    authCache.setSecretVerification(apiKey, apiSecret, true);

    // Attach tenant to request
    req.tenant = result.tenant;
    
    // Update lastUsedAt asynchronously (fire and forget)
    executeQuery(
      () => db.apiToken.update({
        where: { id: result.id },
        data: { lastUsedAt: new Date() },
        select: { id: true }
      }),
      { maxRetries: 1, timeout: 2000 }
    ).catch(() => {});
    
    success = true;
    
    // Log slow queries
    const elapsed = Date.now() - startTime;
    if (elapsed > 100) {
      console.warn(`[Auth] Slow query: ${elapsed}ms for key ${apiKey.substring(0, 8)}...`);
    }
    
    next();
  } catch (error: any) {
    console.error('[Auth] Error:', error);
    trackQuery(false);
    
    const elapsed = Date.now() - startTime;
    console.error(`[Auth] Failed after ${elapsed}ms`);
    
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
    trackQuery(success);
  }
};

// Get authentication statistics
export function getAuthStats() {
  return {
    cache: authCache.getStats(),
    config: {
      cacheTTL: CACHE_TTL,
      cacheMaxSize: CACHE_MAX_SIZE
    }
  };
}

// Clear cache (for emergencies or testing)
export function clearAuthCache() {
  authCache.clear();
  // console.log('[Auth] Cache cleared');
}

// Export for testing
export { prewarmCache };