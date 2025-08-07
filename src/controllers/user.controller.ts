import { Response } from "express";
import { db } from "../prisma.js";
import { isValidWalletAddress } from "../utils/index.js";
import { TenantRequest } from "../types/index.js";

/**
 * Create or update a user under the current tenant
 */
export const createUser = async (req: TenantRequest, res: Response) => {
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

    // Check if this wallet already exists for this tenant
    const existingUser = await db.user.findFirst({
      where: { 
        walletAddress: wallet,
        tenantId: tenant.id
      },
    });

    // If user exists for this tenant, update it
    if (existingUser) {
      const updatedUser = await db.user.update({
        where: { id: existingUser.id },
        data: { 
          name: name || existingUser.name,
          email: email || existingUser.email,
          image: image || existingUser.image
        },
      });
      return res.status(200).json({ data: updatedUser, updated: true });
    }

    // Create new user under this tenant
    const user = await db.user.create({
      data: { 
        walletAddress: wallet,
        name: name || null,
        email: email || null,
        image: image || null,
        tenantId: tenant.id,
        points: 0
      },
    });
    
    res.status(201).json({ data: user, created: true });
  } catch (error) {
    console.error("Error creating user:", error);
    res.status(500).json({ error: "An unexpected error occurred." });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * Get a user by wallet address under the current tenant
 */
export const getUser = async (req: TenantRequest, res: Response) => {
  const { userWallet } = req.params;
  const tenant = req.tenant;
  
  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!userWallet) {
      return res.status(400).json({
        error: "Missing required field",
      });
    }

    const user = await db.user.findFirst({
      where: {
        walletAddress: userWallet,
        tenantId: tenant.id
      },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    
    return res.status(200).json(user);
  } catch (error) {
    console.error("Error getting user:", error);
    res.status(500).json({ error: "An unexpected error occurred." });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * Update a user under the current tenant
 */
export const updateUser = async (req: TenantRequest, res: Response) => {
  const { userId } = req.params;
  const updates = req.body;
  const tenant = req.tenant;
  
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
    const existingUser = await db.user.findFirst({
      where: { 
        id: userId,
        tenantId: tenant.id
      },
    });

    if (!existingUser) {
      return res.status(404).json({ error: "User not found or not accessible" });
    }
    const { walletAddress, ...safeUpdates } = updates;

    const user = await db.user.update({
      where: { id: userId },
      data: safeUpdates,
    });

    res.status(200).json({ data: user });
  } catch (error) {
    console.error("Error updating user:", error);
    res.status(500).json({ error: "An unexpected error occurred." });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * List users for the current tenant
 */
export const listUsers = async (req: TenantRequest, res: Response) => {
  const tenant = req.tenant;
  
  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    // Extract pagination params
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    // Count total users for this tenant
    const totalUsers = await db.user.count({
      where: { tenantId: tenant.id }
    });

    // Get users for this tenant
    const users = await db.user.findMany({
      where: { tenantId: tenant.id },
      skip,
      take: limit,
      // orderBy: { createdAt: 'desc' }
    });

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
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * Delete a user under the current tenant
 */
export const deleteUser = async (req: TenantRequest, res: Response) => {
  const { userId } = req.params;
  const tenant = req.tenant;
  
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
    const existingUser = await db.user.findFirst({
      where: { 
        id: userId,
        tenantId: tenant.id
      },
    });

    if (!existingUser) {
      return res.status(404).json({ error: "User not found or not accessible" });
    }

    // Delete the user
    await db.user.delete({
      where: { id: userId }
    });

    res.status(200).json({ success: true, message: "User deleted successfully" });
  } catch (error) {
    console.error("Error deleting user:", error);
    res.status(500).json({ error: "An unexpected error occurred." });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};