import { Response } from "express";
import { db, executeQuery, trackQuery } from "../prisma.js";
import { isValidWalletAddress } from "../utils/index.js";
import { TenantRequest } from "../types/index.js";

// Cache for user lookups (wallet -> user data)
const userCache = new Map<string, { data: any; timestamp: number }>();
const USER_CACHE_TTL = 60000; // 1 minute

// Helper to get cache key
function getUserCacheKey(wallet: string, tenantId: string): string {
  return `${tenantId}:${wallet}`;
}

/**
 * Create or update a user under the current tenant - OPTIMIZED
 */
export const createUser = async (req: TenantRequest, res: Response) => {
  let success = false;
  
  try {
    const { wallet, name, email, image } = req.body;
    const tenant = req.tenant;

    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!wallet || typeof wallet !== "string") {
      return res.status(400).json({ error: "Wallet address is required." });
    }

    if (!isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    // Check cache first
    const cacheKey = getUserCacheKey(wallet, tenant.id);
    const cached = userCache.get(cacheKey);
    
    let existingUser = null;
    if (cached && Date.now() - cached.timestamp < USER_CACHE_TTL) {
      existingUser = cached.data;
    } else {
      // Cache miss - query database
      existingUser = await executeQuery(
        () => db.user.findFirst({
          where: { 
            walletAddress: wallet,
            tenantId: tenant.id
          },
        }),
        { maxRetries: 2, timeout: 10000 }
      );
    }

    // If user exists for this tenant, update it
    if (existingUser) {
      const updatedUser = await executeQuery(
        () => db.user.update({
          where: { id: existingUser.id },
          data: { 
            name: name || existingUser.name,
            email: email || existingUser.email,
            image: image || existingUser.image
          },
        }),
        { maxRetries: 2, timeout: 10000 }
      );
      
      // Update cache
      userCache.set(cacheKey, { data: updatedUser, timestamp: Date.now() });
      
      success = true;
      return res.status(200).json({ data: updatedUser, updated: true });
    }

    // Create new user under this tenant
    const user = await executeQuery(
      () => db.user.create({
        data: { 
          walletAddress: wallet,
          name: name || null,
          email: email || null,
          image: image || null,
          tenantId: tenant.id,
          points: 0
        },
      }),
      { maxRetries: 2, timeout: 10000 }
    );
    
    // Cache the new user
    userCache.set(cacheKey, { data: user, timestamp: Date.now() });
    
    success = true;
    res.status(201).json({ data: user, created: true });
  } catch (error) {
    console.error("Error creating user:", error);
    res.status(500).json({ error: "An unexpected error occurred." });
  } finally {
    trackQuery(success);
  }
};

/**
 * Get a user by wallet address under the current tenant - OPTIMIZED
 */
export const getUser = async (req: TenantRequest, res: Response) => {
  const { userWallet } = req.params;
  const tenant = req.tenant;
  let success = false;
  
  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!userWallet) {
      return res.status(400).json({
        error: "Missing required field",
      });
    }

    // Check cache first
    const cacheKey = getUserCacheKey(userWallet, tenant.id);
    const cached = userCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < USER_CACHE_TTL) {
      success = true;
      return res.status(200).json(cached.data);
    }

    // Cache miss - query database
    const user = await executeQuery(
      () => db.user.findFirst({
        where: {
          walletAddress: userWallet,
          tenantId: tenant.id
        },
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    
    // Cache the result
    userCache.set(cacheKey, { data: user, timestamp: Date.now() });
    
    success = true;
    return res.status(200).json(user);
  } catch (error) {
    console.error("Error getting user:", error);
    res.status(500).json({ error: "An unexpected error occurred." });
  } finally {
    trackQuery(success);
  }
};

/**
 * Update a user under the current tenant - OPTIMIZED
 */
export const updateUser = async (req: TenantRequest, res: Response) => {
  const { userId } = req.params;
  const updates = req.body;
  const tenant = req.tenant;
  let success = false;
  
  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!userId) {
      return res.status(400).json({
        error: "Missing required field",
      });
    }

    // Verify the user belongs to this tenant
    const existingUser = await executeQuery(
      () => db.user.findFirst({
        where: { 
          id: userId,
          tenantId: tenant.id
        },
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    if (!existingUser) {
      return res.status(404).json({ error: "User not found or not accessible" });
    }
    
    // Remove walletAddress from updates for security
    const { walletAddress, ...safeUpdates } = updates;

    const user = await executeQuery(
      () => db.user.update({
        where: { id: userId },
        data: safeUpdates,
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    // Invalidate cache for this user
    const cacheKey = getUserCacheKey(user.walletAddress, tenant.id);
    userCache.delete(cacheKey);
    
    success = true;
    res.status(200).json({ data: user });
  } catch (error) {
    console.error("Error updating user:", error);
    res.status(500).json({ error: "An unexpected error occurred." });
  } finally {
    trackQuery(success);
  }
};

/**
 * List users for the current tenant - OPTIMIZED
 */
export const listUsers = async (req: TenantRequest, res: Response) => {
  const tenant = req.tenant;
  let success = false;
  
  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    // Extract pagination params with validation
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));
    const skip = (page - 1) * limit;

    // Run count and fetch in parallel
    const [totalUsers, users] = await Promise.all([
      executeQuery(
        () => db.user.count({
          where: { tenantId: tenant.id }
        }),
        { maxRetries: 1, timeout: 5000 }
      ),
      executeQuery(
        () => db.user.findMany({
          where: { tenantId: tenant.id },
          skip,
          take: limit,
          select: {
            id: true,
            walletAddress: true,
            name: true,
            email: true,
            image: true,
            points: true,
            emailVerified: true
          }
        }),
        { maxRetries: 2, timeout: 10000 }
      )
    ]);

    success = true;
    res.status(200).json({ 
      data: users,
      pagination: {
        total: totalUsers,
        page,
        pageSize: limit,
        totalPages: Math.ceil(totalUsers / limit)
      }
    });
  } catch (error) {
    console.error("Error listing users:", error);
    res.status(500).json({ error: "An unexpected error occurred." });
  } finally {
    trackQuery(success);
  }
};

/**
 * Delete a user under the current tenant - OPTIMIZED
 */
export const deleteUser = async (req: TenantRequest, res: Response) => {
  const { userId } = req.params;
  const tenant = req.tenant;
  let success = false;
  
  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!userId) {
      return res.status(400).json({
        error: "Missing required field",
      });
    }

    // Verify the user belongs to this tenant
    const existingUser = await executeQuery(
      () => db.user.findFirst({
        where: { 
          id: userId,
          tenantId: tenant.id
        },
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    if (!existingUser) {
      return res.status(404).json({ error: "User not found or not accessible" });
    }

    // Delete the user
    await executeQuery(
      () => db.user.delete({
        where: { id: userId }
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    // Invalidate cache
    const cacheKey = getUserCacheKey(existingUser.walletAddress, tenant.id);
    userCache.delete(cacheKey);
    
    success = true;
    res.status(200).json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    console.error("Error deleting user:", error);
    res.status(500).json({ error: "An unexpected error occurred." });
  } finally {
    trackQuery(success);
  }
};

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of userCache.entries()) {
    if (now - value.timestamp > USER_CACHE_TTL) {
      userCache.delete(key);
    }
  }
}, 60000); // Clean every minute