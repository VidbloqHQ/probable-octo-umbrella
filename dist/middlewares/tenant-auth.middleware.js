import * as bcrypt from "bcryptjs";
import { db } from "../prisma.js";
/**
 * Middleware to authenticate API key and load tenant
 */
export const authenticateTenant = async (req, res, next) => {
    // CRITICAL: Skip authentication for OPTIONS preflight requests
    if (req.method === 'OPTIONS') {
        return next();
    }
    try {
        const apiKey = req.headers["x-api-key"];
        const apiSecret = req.headers["x-api-secret"];
        if (!apiKey || !apiSecret) {
            return res.status(401).json({ error: "API credentials required" });
        }
        // Find the API token
        const apiToken = await db.apiToken.findUnique({
            where: { key: apiKey },
            include: { tenant: true },
        });
        if (!apiToken || !apiToken.isActive) {
            return res.status(401).json({ error: "Invalid or revoked API key" });
        }
        // Check if token has expired
        if (apiToken.expiresAt && new Date(apiToken.expiresAt) < new Date()) {
            return res.status(401).json({ error: "API key has expired" });
        }
        // Verify the secret
        const validSecret = await bcrypt.compare(apiSecret, apiToken.secret);
        if (!validSecret) {
            return res.status(401).json({ error: "Invalid API credentials" });
        }
        // Update last used timestamp
        await db.apiToken.update({
            where: { id: apiToken.id },
            data: { lastUsedAt: new Date() },
        });
        // Attach tenant to request
        req.tenant = apiToken.tenant;
        next();
    }
    catch (error) {
        console.error("Authentication error:", error);
        return res.status(500).json({ error: "Authentication error" });
    }
    finally {
        await db.$disconnect();
    }
};
