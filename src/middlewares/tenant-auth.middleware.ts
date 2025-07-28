import { Response, NextFunction } from "express";
import * as bcrypt from "bcryptjs";
import { db } from "../prisma.js";
import { TenantRequest } from "../types/index.js";

/**
 * Middleware to authenticate API key and load tenant
 */
export const authenticateTenant = async (
  req: TenantRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const apiKey = req.headers["x-api-key"] as string;
    const apiSecret = req.headers["x-api-secret"] as string;

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

    console.log("api-token", apiToken);
    next();
  } catch (error) {
    console.error("Authentication error:", error);
    return res.status(500).json({ error: "Authentication error" });
  } finally {
    await db.$disconnect();
  }
};

// Uncomment the following code block if you want to include domain validation
// and tenant's authorized domains in the authentication process
// With allowedDomains check
/**
 * Middleware to authenticate API key and load tenant with domain validation
 */
// export const authenticateTenant = async (
//   req: TenantRequest,
//   res: Response,
//   next: NextFunction
// ) => {
//   try {
//     const apiKey = req.headers["x-api-key"] as string;
//     const apiSecret = req.headers["x-api-secret"] as string;

//     if (!apiKey || !apiSecret) {
//       return res.status(401).json({ error: "API credentials required" });
//     }

//     // Find the API token
//     const apiToken = await db.apiToken.findUnique({
//       where: { key: apiKey },
//       include: {
//         tenant: {
//           include: {
//             authorizedDomains: true // Include tenant's authorized domains
//           }
//         }
//       }
//     });

//     if (!apiToken || !apiToken.isActive) {
//       return res.status(401).json({ error: "Invalid or revoked API key" });
//     }

//     // Check if token has expired
//     if (apiToken.expiresAt && new Date(apiToken.expiresAt) < new Date()) {
//       return res.status(401).json({ error: "API key has expired" });
//     }

//     // Verify the secret
//     const validSecret = await bcrypt.compare(apiSecret, apiToken.secret);

//     if (!validSecret) {
//       return res.status(401).json({ error: "Invalid API credentials" });
//     }

//     // Domain validation - only if the tenant has authorized domains configured
//     if (apiToken.tenant.authorizedDomains.length > 0) {
//       const origin = req.headers.origin || req.headers.referer;

//       // For non-browser requests (e.g., server-to-server, mobile apps)
//       // we'll skip domain validation if no origin is provided
//       if (origin) {
//         try {
//           // Extract domain from origin URL
//           const originDomain = new URL(origin).hostname;

//           // Check if the domain is in the tenant's authorized domains
//           const isAllowedDomain = apiToken.tenant.authorizedDomains.some(
//             domain => {
//               // Exact domain match
//               if (domain.domain === originDomain) return true;

//               // Subdomain support - if domain is configured as *.example.com
//               if (domain.domain.startsWith('*.')) {
//                 const baseDomain = domain.domain.substring(2);
//                 return originDomain.endsWith(baseDomain);
//               }

//               return false;
//             }
//           );

//           if (!isAllowedDomain) {
//             return res.status(403).json({
//               error: "This domain is not authorized for this tenant",
//               requestOrigin: originDomain
//             });
//           }
//         } catch (urlError) {
//           // Invalid origin URL format
//           return res.status(403).json({
//             error: "Invalid origin format",
//             providedOrigin: origin
//           });
//         }
//       }
//     }

//     // Update last used timestamp
//     await db.apiToken.update({
//       where: { id: apiToken.id },
//       data: { lastUsedAt: new Date() }
//     });

//     // Attach tenant to request
//     req.tenant = apiToken.tenant;

//     next();
//   } catch (error) {
//     console.error("Authentication error:", error);
//     return res.status(500).json({ error: "Authentication error" });
//   } finally {
//     await db.$disconnect();
//   }
// };
