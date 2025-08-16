// import express, { Request, Response, NextFunction } from "express";
// import { createServer } from "http";
// import {
//   TenantRouter,
//   UserRouter,
//   StreamRouter,
//   AgendaRouter,
//   PaymentRouter,
//   PollRouter,
//   ParticipantRouter,
//   QuizRouter,
//   TenantMeRouter,
//   ProgramRouter,
//   MonitorRouter
// } from "./routes/index.js";
// import { beaconHandler, authenticateTenant } from "./middlewares/index.js";
// // Use the simpler version to avoid TypeScript issues with redirect overloading
// import { responseGuard } from "./middlewares/response-guard.middleware.js";
// import { startEnhancedReconciliationJob } from "./services/participantReconciliation.js";
// import createSocketServer from "./websocket.js";
// import { isDatabaseHealthy, getDatabaseMetrics, db, executeQuery } from "./prisma.js";
// import { getAuthStats } from "./middlewares/tenant-auth.middleware.js";
// const app = express();
// const PORT = process.env.PORT || 8001;
// const httpServer = createServer(app);
// const MAX_REQUEST_TIMEOUT = parseInt(process.env.MAX_REQUEST_TIMEOUT || '30000');
// export const wss = createSocketServer(httpServer);
// // Trust proxy (important for Railway/Render/Heroku) - MUST BE FIRST
// app.set('trust proxy', true);
// // ============================================
// // DYNAMIC CORS WITH AUTHORIZED DOMAINS
// // ============================================
// // Cache for authorized domains (refreshed periodically)
// const authorizedDomainsCache = new Map<string, Set<string>>();
// let lastCacheRefresh = 0;
// const CACHE_REFRESH_INTERVAL = 60000; // Refresh every minute
// /**
//  * Refresh the authorized domains cache
//  */
// async function refreshAuthorizedDomainsCache() {
//   try {
//     const domains = await executeQuery(
//       () => db.authorizedDomain.findMany({
//         select: {
//           domain: true,
//           tenantId: true
//         }
//       }),
//       { maxRetries: 1, timeout: 5000 }
//     );
//     // Clear and rebuild cache
//     authorizedDomainsCache.clear();
//     for (const { domain, tenantId } of domains) {
//       if (!authorizedDomainsCache.has(tenantId)) {
//         authorizedDomainsCache.set(tenantId, new Set());
//       }
//       authorizedDomainsCache.get(tenantId)!.add(domain);
//     }
//     lastCacheRefresh = Date.now();
//     console.log(`Authorized domains cache refreshed: ${domains.length} domains for ${authorizedDomainsCache.size} tenants`);
//   } catch (error) {
//     console.error('Failed to refresh authorized domains cache:', error);
//   }
// }
// // Initial cache load (delayed to allow database to be ready)
// setTimeout(refreshAuthorizedDomainsCache, 5000);
// // Periodic cache refresh
// setInterval(refreshAuthorizedDomainsCache, CACHE_REFRESH_INTERVAL);
// /**
//  * Extract hostname from origin for comparison
//  * KEEP subdomains (www, staging, etc)
//  */
// function normalizeOrigin(origin: string): string {
//   try {
//     const url = new URL(origin);
//     // Return full hostname including subdomains
//     return url.hostname + (url.port ? ':' + url.port : '');
//   } catch {
//     // If not a valid URL, return as-is
//     return origin.replace(/^https?:\/\//, '').replace(/\/$/, '');
//   }
// }
// /**
//  * Check if an origin is authorized for any tenant
//  */
// function isOriginAuthorized(origin: string): boolean {
//   const normalizedOrigin = normalizeOrigin(origin);
//   // Check all tenants' authorized domains
//   for (const domains of authorizedDomainsCache.values()) {
//     if (domains.has(normalizedOrigin)) {
//       return true;
//     }
//   }
//   return false;
// }
// // ============================================
// // CUSTOM CORS MIDDLEWARE - MUST BE FIRST!
// // ============================================
// app.use((req: Request, res: Response, next: NextFunction) => {
//   const origin = req.headers.origin as string;
//   // Development mode: Allow all origins
//   if (process.env.NODE_ENV === 'development') {
//     res.setHeader('Access-Control-Allow-Origin', origin || '*');
//   } 
//   // No origin header (server-to-server, mobile apps, Postman)
//   else if (!origin) {
//     res.setHeader('Access-Control-Allow-Origin', '*');
//   } 
//   // Check against authorized domains
//   else {
//     // Check if it's localhost (for development)
//     const isLocalhost = origin.includes('localhost') || 
//                        origin.includes('127.0.0.1') || 
//                        origin.includes('::1');
//     // Allow localhost if configured
//     if (isLocalhost && process.env.ALLOW_LOCALHOST === 'true') {
//       res.setHeader('Access-Control-Allow-Origin', origin);
//     } 
//     // Check if origin is in any tenant's authorized domains
//     else if (isOriginAuthorized(origin)) {
//       res.setHeader('Access-Control-Allow-Origin', origin);
//     } 
//     // Check against your admin/dashboard domains (if you have any)
//     else {
//       // Your own admin dashboard domains (if applicable)
//       const adminDomains = process.env.ADMIN_DOMAINS 
//         ? process.env.ADMIN_DOMAINS.split(',').map(o => o.trim())
//         : [
//           // Add your admin dashboard domain here if you have one
//           // 'https://admin.yourservice.com',
//           // 'https://dashboard.yourservice.com'
//         ];
//       if (adminDomains.length > 0 && adminDomains.some(allowed => origin.startsWith(allowed))) {
//         res.setHeader('Access-Control-Allow-Origin', origin);
//       } else {
//         // For SDK-based SaaS, we need to be permissive during onboarding
//         // Tenants need to test before adding their domain to authorized list
//         if (process.env.STRICT_CORS === 'true') {
//           // Strict mode: Only allow registered domains
//           console.warn(`CORS: Blocked unregistered origin: ${origin}`);
//           // Don't set Access-Control-Allow-Origin header - this will block the request
//         } else {
//           // Permissive mode: Allow but log for monitoring
//           // This allows tenants to test integration before registering their domain
//           console.log(`CORS: Allowing unregistered origin: ${origin} (consider adding to authorized domains)`);
//           res.setHeader('Access-Control-Allow-Origin', origin);
//         }
//       }
//     }
//   }
//   // Set all CORS headers
//   res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
//   res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-api-secret, X-Requested-With, Accept, Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
//   res.setHeader('Access-Control-Allow-Credentials', 'true');
//   res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
//   res.setHeader('Access-Control-Expose-Headers', 'x-request-id, X-Total-Count, X-Page, X-Per-Page');
//   // Handle OPTIONS method (preflight)
//   if (req.method === 'OPTIONS') {
//     // Preflight request. Reply successfully:
//     res.sendStatus(204);
//     return;
//   }
//   next();
// });
// // Body parser configuration - AFTER CORS
// app.use(express.json({ limit: '10mb' }));
// app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// // ============================================
// // RESPONSE GUARD MIDDLEWARE - CRITICAL!
// // This prevents ERR_HTTP_HEADERS_SENT errors
// // ============================================
// app.use(responseGuard);
// // Request ID middleware for tracing
// app.use((req: Request, res: Response, next) => {
//   req.id = req.headers['x-request-id'] as string || 
//            `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
//   res.setHeader('x-request-id', req.id);
//   next();
// });
// // ============================================
// // MONITORING ENDPOINTS (NO AUTH - FOR EMERGENCY ACCESS)
// // ============================================
// app.use("/monitor", MonitorRouter.default);
// // Health check endpoint (no auth required)
// app.get('/health', async (req: Request, res: Response) => {
//   try {
//     const [dbHealthy, dbMetrics] = await Promise.all([
//       isDatabaseHealthy(),
//       getDatabaseMetrics()
//     ]);
//     const authStats = getAuthStats();
//     // Check for critical issues
//     const issues = [];
//     if (dbMetrics && typeof dbMetrics === 'object' && 'idleTransactions' in dbMetrics) {
//       if ((dbMetrics as any).idleTransactions > 5) {
//         issues.push(`High idle transaction count: ${(dbMetrics as any).idleTransactions}`);
//       }
//     }
//     const status = {
//       status: dbHealthy && issues.length === 0 ? 'healthy' : 'unhealthy',
//       timestamp: new Date().toISOString(),
//       environment: process.env.NODE_ENV || 'development',
//       database: {
//         connected: dbHealthy,
//         metrics: dbMetrics
//       },
//       auth: authStats,
//       cors: {
//         authorizedDomainsCount: Array.from(authorizedDomainsCache.values()).reduce((sum, set) => sum + set.size, 0),
//         tenantsWithDomains: authorizedDomainsCache.size,
//         lastCacheRefresh: lastCacheRefresh ? new Date(lastCacheRefresh).toISOString() : 'pending'
//       },
//       system: {
//         uptime: process.uptime(),
//         memory: process.memoryUsage(),
//         node: process.version,
//         platform: process.platform
//       },
//       issues: issues.length > 0 ? issues : undefined
//     };
//     res.status(dbHealthy ? 200 : 503).json(status);
//   } catch (error) {
//     console.error('Health check error:', error);
//     res.status(503).json({ 
//       status: 'error',
//       error: error instanceof Error ? error.message : 'Unknown error'
//     });
//   }
// });
// // Readiness check (for container orchestration)
// app.get('/ready', async (req: Request, res: Response) => {
//   try {
//     const isReady = await isDatabaseHealthy();
//     res.status(isReady ? 200 : 503).json({ ready: isReady });
//   } catch (error) {
//     res.status(503).json({ ready: false });
//   }
// });
// // Apply beacon handler
// app.use(beaconHandler);
// // Request logging middleware
// if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_REQUEST_LOGGING === 'true') {
//   app.use((req: Request, res: Response, next) => {
//     if (!['/health', '/ready', '/monitor/db-health'].includes(req.path)) {
//       const start = Date.now();
//       res.on('finish', () => {
//         const duration = Date.now() - start;
//         if (duration > 1000) {
//           console.warn(`[SLOW] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
//         } else if (process.env.LOG_ALL_REQUESTS === 'true') {
//           console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
//         }
//       });
//     }
//     next();
//   });
// }
// // Request timeout middleware with better cleanup
// app.use((req: Request, res: Response, next) => {
//   // Skip timeout for specific endpoints
//   if (['/health', '/ready', '/monitor/db-health'].includes(req.path)) {
//     return next();
//   }
//   let timeoutHandle: NodeJS.Timeout | null = null;
//   let cleaned = false;
//   const cleanup = () => {
//     if (!cleaned) {
//       cleaned = true;
//       if (timeoutHandle) {
//         clearTimeout(timeoutHandle);
//         timeoutHandle = null;
//       }
//     }
//   };
//   timeoutHandle = setTimeout(() => {
//     if (!res.headersSent) {
//       console.error(`Request timeout: ${req.method} ${req.path}`);
//       res.status(504).json({ 
//         error: "Request timeout",
//         code: "REQUEST_TIMEOUT",
//         timeout: MAX_REQUEST_TIMEOUT
//       });
//       cleanup();
//     }
//   }, MAX_REQUEST_TIMEOUT);
//   // Clear timeout when response is sent
//   res.on('finish', cleanup);
//   res.on('close', cleanup);
//   res.on('error', cleanup);
//   next();
// });
// // Delay participant reconciliation startup
// let reconciliationJob: any = null;
// setTimeout(() => {
//   console.log("Starting participant reconciliation job...");
//   try {
//     reconciliationJob = startEnhancedReconciliationJob();
//   } catch (error) {
//     console.error("Failed to start reconciliation job:", error);
//   }
// }, process.env.RECONCILIATION_DELAY ? parseInt(process.env.RECONCILIATION_DELAY) : 10000);
// // Public routes (no authentication required)
// app.use("/tenant", TenantRouter.default);
// // Protected routes - authenticateTenant middleware should skip OPTIONS requests
// app.use(authenticateTenant);
// app.use("/tenant/me", TenantMeRouter.default);
// app.use("/user", UserRouter.default);
// app.use("/stream", StreamRouter.default);
// app.use("/pay", PaymentRouter.default);
// app.use("/agenda", AgendaRouter.default);
// app.use("/poll", PollRouter.default);
// app.use("/participant", ParticipantRouter.default);
// app.use("/quiz", QuizRouter.default);
// app.use("/program", ProgramRouter.default);
// // 404 handler
// app.all("*", (req: Request, res: Response) => {
//   res.status(404).json({ 
//     error: `Route ${req.originalUrl} not found`,
//     code: "ROUTE_NOT_FOUND"
//   });
// });
// // Global error handler - MUST BE LAST
// app.use((err: any, req: Request, res: Response, next: NextFunction) => {
//   const requestId = (req as any).id;
//   console.error(`[${requestId}] Unhandled error:`, err);
//   // Don't leak error details in production
//   const isDev = process.env.NODE_ENV === 'development';
//   // Check if response was already sent
//   if (res.headersSent) {
//     console.error(`[${requestId}] Error occurred after response was sent`);
//     return;
//   }
//   // Database connection errors
//   if (err.code === 'P2024' || err.code === 'P2034') {
//     return res.status(503).json({
//       error: "Service temporarily unavailable",
//       code: "SERVICE_UNAVAILABLE",
//       message: "The server is experiencing high load. Please try again.",
//       requestId
//     });
//   }
//   if (err.code === 'P1001' || err.code === 'P1002') {
//     return res.status(503).json({
//       error: "Database connection error",
//       code: "DB_CONNECTION_ERROR",
//       message: "Unable to connect to the database. Please try again.",
//       requestId
//     });
//   }
//   // Default error response
//   res.status(500).json({
//     error: "Internal server error",
//     code: "INTERNAL_ERROR",
//     message: isDev ? err.message : undefined,
//     stack: isDev ? err.stack : undefined,
//     requestId
//   });
// });
// // ============================================
// // GRACEFUL SHUTDOWN WITH CONNECTION CLEANUP
// // ============================================
// const shutdown = async (signal: string) => {
//   console.log(`\n${signal} received, starting graceful shutdown...`);
//   const shutdownTimeout = setTimeout(() => {
//     console.error('Graceful shutdown timeout, forcing exit');
//     process.exit(1);
//   }, 30000); // 30 second timeout
//   try {
//     // Kill any idle database transactions before shutdown
//     console.log('Cleaning up idle database transactions...');
//     try {
//       await db.$queryRawUnsafe(`
//         SELECT pg_terminate_backend(pid)
//         FROM pg_stat_activity
//         WHERE datname = current_database()
//           AND state = 'idle in transaction'
//       `);
//       console.log('Idle transactions terminated');
//     } catch (error) {
//       console.error('Failed to kill idle transactions:', error);
//     }
//     // Stop accepting new connections
//     console.log('Closing HTTP server...');
//     await new Promise<void>((resolve, reject) => {
//       httpServer.close((err) => {
//         if (err) reject(err);
//         else resolve();
//       });
//     });
//     console.log('HTTP server closed');
//     // Close WebSocket server
//     if (wss) {
//       console.log('Closing WebSocket server...');
//       await new Promise<void>((resolve) => {
//         wss.close(() => resolve());
//       });
//       console.log('WebSocket server closed');
//     }
//     // Stop reconciliation job
//     if (reconciliationJob) {
//       console.log('Stopping reconciliation job...');
//       try {
//         if (typeof reconciliationJob === 'function') {
//           reconciliationJob();
//         }
//       } catch (error) {
//         console.error('Error stopping reconciliation job:', error);
//       }
//     }
//     // Database will be closed by prisma.ts shutdown handler
//     clearTimeout(shutdownTimeout);
//     console.log('Graceful shutdown completed');
//     process.exit(0);
//   } catch (error) {
//     console.error('Error during shutdown:', error);
//     clearTimeout(shutdownTimeout);
//     process.exit(1);
//   }
// };
// // Register shutdown handlers
// process.once('SIGTERM', () => shutdown('SIGTERM'));
// process.once('SIGINT', () => shutdown('SIGINT'));
// // Handle uncaught errors
// process.on('uncaughtException', (error) => {
//   console.error('Uncaught Exception:', error);
//   // Log but don't exit in production
//   if (process.env.NODE_ENV === 'production') {
//     // Try to recover
//     console.error('Attempting to continue despite uncaught exception');
//   } else {
//     shutdown('uncaughtException');
//   }
// });
// process.on('unhandledRejection', (reason, promise) => {
//   console.error('Unhandled Rejection at:', promise, 'reason:', reason);
//   // Don't exit on unhandled rejection
//   if (process.env.NODE_ENV === 'development') {
//     console.error('Development mode: Consider fixing this unhandled rejection');
//   }
// });
// // Start server
// httpServer.listen(PORT, () => {
//   console.log(`
// ╔═════════════════════════════════════════╗
// ║         Server Started Successfully     ║
// ╠═════════════════════════════════════════╣
// ║ Port:        ${PORT.toString().padEnd(27)}║
// ║ Environment: ${(process.env.NODE_ENV || 'development').padEnd(27)}║
// ║ Node:        ${process.version.padEnd(27)}║
// ║ Platform:    ${process.platform.padEnd(27)}║
// ║ PID:         ${process.pid.toString().padEnd(27)}║
// ╚═════════════════════════════════════════╝
//   `);
//   if (!process.env.DATABASE_URL) {
//     console.warn('⚠️  WARNING: No DATABASE_URL environment variable set');
//   }
//   console.log('🛡️  Response Guard: Enabled (prevents double responses)');
//   console.log('📊 Database Monitor: Available at /monitor/db-health');
//   console.log('🔄 CORS: Dynamic domain authorization enabled');
//   console.log(`🔄 CORS: Cache will refresh every ${CACHE_REFRESH_INTERVAL/1000} seconds`);
//   console.log('🔄 CORS: Localhost allowed:', process.env.ALLOW_LOCALHOST === 'true' ? 'Yes' : 'No');
//   console.log('🔄 CORS: Strict mode:', process.env.STRICT_CORS === 'true' ? 'Yes (block unknown origins)' : 'No (allow with warning)');
//   // Check database health on startup
//   setTimeout(async () => {
//     try {
//       const metrics = await getDatabaseMetrics();
//       if (metrics && typeof metrics === 'object' && 'idleTransactions' in metrics) {
//         const idleCount = (metrics as any).idleTransactions;
//         if (idleCount > 0) {
//           console.warn(`⚠️  WARNING: ${idleCount} idle transactions detected on startup`);
//           console.warn('   Run: curl -X POST http://localhost:' + PORT + '/monitor/db-health/kill-idle');
//         }
//       }
//     } catch (error) {
//       console.error('Failed to check initial database health:', error);
//     }
//   }, 5000);
// });
// // Add TypeScript declaration for request ID
// declare global {
//   namespace Express {
//     interface Request {
//       id?: string;
//     }
//   }
// }
import express from "express";
import { createServer } from "http";
import { TenantRouter, UserRouter, StreamRouter, AgendaRouter, PaymentRouter, PollRouter, ParticipantRouter, QuizRouter, TenantMeRouter, ProgramRouter, MonitorRouter } from "./routes/index.js";
import { beaconHandler, authenticateTenant } from "./middlewares/index.js";
import { responseGuard } from "./middlewares/response-guard.middleware.js";
import { startEnhancedReconciliationJob } from "./services/participantReconciliation.js";
import createSocketServer from "./websocket.js";
import { isDatabaseHealthy, getDatabaseMetrics, db, executeQuery } from "./prisma.js";
import { getAuthStats } from "./middlewares/tenant-auth.middleware.js";
const app = express();
const PORT = process.env.PORT || 8001;
const httpServer = createServer(app);
// REDUCED timeout from 30 seconds to 15 seconds
const MAX_REQUEST_TIMEOUT = parseInt(process.env.MAX_REQUEST_TIMEOUT || '15000');
export const wss = createSocketServer(httpServer);
// Trust proxy (important for Railway/Render/Heroku) - MUST BE FIRST
app.set('trust proxy', true);
// ============================================
// DYNAMIC CORS WITH AUTHORIZED DOMAINS
// ============================================
// Cache for authorized domains (refreshed periodically)
const authorizedDomainsCache = new Map();
let lastCacheRefresh = 0;
const CACHE_REFRESH_INTERVAL = 60000; // Refresh every minute
/**
 * Refresh the authorized domains cache
 */
async function refreshAuthorizedDomainsCache() {
    try {
        const domains = await executeQuery(() => db.authorizedDomain.findMany({
            select: {
                domain: true,
                tenantId: true
            }
        }), { maxRetries: 1, timeout: 5000 });
        // Clear and rebuild cache
        authorizedDomainsCache.clear();
        for (const { domain, tenantId } of domains) {
            if (!authorizedDomainsCache.has(tenantId)) {
                authorizedDomainsCache.set(tenantId, new Set());
            }
            authorizedDomainsCache.get(tenantId).add(domain);
        }
        lastCacheRefresh = Date.now();
        console.log(`Authorized domains cache refreshed: ${domains.length} domains for ${authorizedDomainsCache.size} tenants`);
    }
    catch (error) {
        console.error('Failed to refresh authorized domains cache:', error);
    }
}
// Initial cache load (delayed to allow database to be ready)
setTimeout(refreshAuthorizedDomainsCache, 5000);
// Periodic cache refresh
setInterval(refreshAuthorizedDomainsCache, CACHE_REFRESH_INTERVAL);
/**
 * Extract hostname from origin for comparison
 * KEEP subdomains (www, staging, etc)
 */
function normalizeOrigin(origin) {
    try {
        const url = new URL(origin);
        // Return full hostname including subdomains
        return url.hostname + (url.port ? ':' + url.port : '');
    }
    catch {
        // If not a valid URL, return as-is
        return origin.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }
}
/**
 * Check if an origin is authorized for any tenant
 */
function isOriginAuthorized(origin) {
    const normalizedOrigin = normalizeOrigin(origin);
    // Check all tenants' authorized domains
    for (const domains of authorizedDomainsCache.values()) {
        if (domains.has(normalizedOrigin)) {
            return true;
        }
    }
    return false;
}
// ============================================
// CUSTOM CORS MIDDLEWARE - MUST BE FIRST!
// ============================================
app.use((req, res, next) => {
    const origin = req.headers.origin;
    // Development mode: Allow all origins
    if (process.env.NODE_ENV === 'development') {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }
    // No origin header (server-to-server, mobile apps, Postman)
    else if (!origin) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    // Check against authorized domains
    else {
        // Check if it's localhost (for development)
        const isLocalhost = origin.includes('localhost') ||
            origin.includes('127.0.0.1') ||
            origin.includes('::1');
        // Allow localhost if configured
        if (isLocalhost && process.env.ALLOW_LOCALHOST === 'true') {
            res.setHeader('Access-Control-Allow-Origin', origin);
        }
        // Check if origin is in any tenant's authorized domains
        else if (isOriginAuthorized(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
        }
        // Check against your admin/dashboard domains (if you have any)
        else {
            // Your own admin dashboard domains (if applicable)
            const adminDomains = process.env.ADMIN_DOMAINS
                ? process.env.ADMIN_DOMAINS.split(',').map(o => o.trim())
                : [];
            if (adminDomains.length > 0 && adminDomains.some(allowed => origin.startsWith(allowed))) {
                res.setHeader('Access-Control-Allow-Origin', origin);
            }
            else {
                // For SDK-based SaaS, we need to be permissive during onboarding
                if (process.env.STRICT_CORS === 'true') {
                    // Strict mode: Only allow registered domains
                    console.warn(`CORS: Blocked unregistered origin: ${origin}`);
                    // Don't set Access-Control-Allow-Origin header - this will block the request
                }
                else {
                    // Permissive mode: Allow but log for monitoring
                    console.log(`CORS: Allowing unregistered origin: ${origin} (consider adding to authorized domains)`);
                    res.setHeader('Access-Control-Allow-Origin', origin);
                }
            }
        }
    }
    // Set all CORS headers
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-api-secret, X-Requested-With, Accept, Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
    res.setHeader('Access-Control-Expose-Headers', 'x-request-id, X-Total-Count, X-Page, X-Per-Page');
    // Handle OPTIONS method (preflight)
    if (req.method === 'OPTIONS') {
        // Preflight request. Reply successfully:
        res.sendStatus(204);
        return;
    }
    next();
});
// Body parser configuration - AFTER CORS
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// ============================================
// RESPONSE GUARD MIDDLEWARE - CRITICAL!
// This prevents ERR_HTTP_HEADERS_SENT errors
// ============================================
app.use(responseGuard);
// Request ID middleware for tracing
app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] ||
        `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    res.setHeader('x-request-id', req.id);
    next();
});
// ============================================
// MONITORING ENDPOINTS (NO AUTH - FOR EMERGENCY ACCESS)
// ============================================
app.use("/monitor", MonitorRouter.default);
// Health check endpoint (no auth required)
app.get('/health', async (req, res) => {
    try {
        const [dbHealthy, dbMetrics] = await Promise.all([
            isDatabaseHealthy(),
            getDatabaseMetrics()
        ]);
        const authStats = getAuthStats();
        // Check for critical issues
        const issues = [];
        if (dbMetrics && typeof dbMetrics === 'object' && 'idleTransactions' in dbMetrics) {
            if (dbMetrics.idleTransactions > 5) {
                issues.push(`High idle transaction count: ${dbMetrics.idleTransactions}`);
            }
        }
        const status = {
            status: dbHealthy && issues.length === 0 ? 'healthy' : 'unhealthy',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            database: {
                connected: dbHealthy,
                metrics: dbMetrics
            },
            auth: authStats,
            cors: {
                authorizedDomainsCount: Array.from(authorizedDomainsCache.values()).reduce((sum, set) => sum + set.size, 0),
                tenantsWithDomains: authorizedDomainsCache.size,
                lastCacheRefresh: lastCacheRefresh ? new Date(lastCacheRefresh).toISOString() : 'pending'
            },
            system: {
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                node: process.version,
                platform: process.platform
            },
            issues: issues.length > 0 ? issues : undefined
        };
        res.status(dbHealthy ? 200 : 503).json(status);
    }
    catch (error) {
        console.error('Health check error:', error);
        res.status(503).json({
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});
// Readiness check (for container orchestration)
app.get('/ready', async (req, res) => {
    try {
        const isReady = await isDatabaseHealthy();
        res.status(isReady ? 200 : 503).json({ ready: isReady });
    }
    catch (error) {
        res.status(503).json({ ready: false });
    }
});
// Apply beacon handler
app.use(beaconHandler);
// Request logging middleware
if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_REQUEST_LOGGING === 'true') {
    app.use((req, res, next) => {
        if (!['/health', '/ready', '/monitor/db-health'].includes(req.path)) {
            const start = Date.now();
            res.on('finish', () => {
                const duration = Date.now() - start;
                if (duration > 1000) {
                    console.warn(`[SLOW] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
                }
                else if (process.env.LOG_ALL_REQUESTS === 'true') {
                    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
                }
            });
        }
        next();
    });
}
// ============================================
// IMPROVED REQUEST TIMEOUT MIDDLEWARE
// Fixed to not double-wrap response methods
// ============================================
app.use((req, res, next) => {
    // Skip timeout for specific endpoints
    if (['/health', '/ready', '/monitor/db-health'].includes(req.path)) {
        return next();
    }
    let timeoutHandle = null;
    let cleaned = false;
    const cleanup = () => {
        if (!cleaned) {
            cleaned = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
        }
    };
    // Add abort controller to request for controllers to check
    req.abortController = new AbortController();
    // Set up timeout handler
    timeoutHandle = setTimeout(() => {
        if (!res.headersSent && !cleaned) {
            console.error(`[TIMEOUT] Request timeout after ${MAX_REQUEST_TIMEOUT}ms: ${req.method} ${req.path}`);
            // Try to abort any ongoing database queries
            if (req.abortController) {
                req.abortController.abort();
            }
            // Mark request as timed out
            req.timedOut = true;
            try {
                res.status(504).json({
                    error: "Request timeout - operation took too long",
                    code: "REQUEST_TIMEOUT",
                    timeout: MAX_REQUEST_TIMEOUT,
                    path: req.path
                });
            }
            catch (err) {
                console.error('[TIMEOUT] Failed to send timeout response:', err);
            }
            cleanup();
        }
    }, MAX_REQUEST_TIMEOUT);
    // Clear timeout when response is complete
    res.on('finish', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    // Also cleanup if headers are sent by other means
    const originalSend = res.send;
    const originalJson = res.json;
    const originalEnd = res.end;
    // Only wrap if not already wrapped by response-guard
    if (!res.__timeoutWrapped) {
        res.__timeoutWrapped = true;
        res.send = function (body) {
            cleanup();
            return originalSend.call(this, body);
        };
        res.json = function (body) {
            cleanup();
            return originalJson.call(this, body);
        };
        res.end = function (...args) {
            cleanup();
            // Cast to any to avoid TypeScript overload issues
            return originalEnd.apply(this, args);
        };
    }
    next();
});
// Delay participant reconciliation startup
let reconciliationJob = null;
setTimeout(() => {
    console.log("Starting participant reconciliation job...");
    try {
        reconciliationJob = startEnhancedReconciliationJob();
    }
    catch (error) {
        console.error("Failed to start reconciliation job:", error);
    }
}, process.env.RECONCILIATION_DELAY ? parseInt(process.env.RECONCILIATION_DELAY) : 10000);
// Public routes (no authentication required)
app.use("/tenant", TenantRouter.default);
// Protected routes - authenticateTenant middleware should skip OPTIONS requests
app.use(authenticateTenant);
app.use("/tenant/me", TenantMeRouter.default);
app.use("/user", UserRouter.default);
app.use("/stream", StreamRouter.default);
app.use("/pay", PaymentRouter.default);
app.use("/agenda", AgendaRouter.default);
app.use("/poll", PollRouter.default);
app.use("/participant", ParticipantRouter.default);
app.use("/quiz", QuizRouter.default);
app.use("/program", ProgramRouter.default);
// 404 handler
app.all("*", (req, res) => {
    res.status(404).json({
        error: `Route ${req.originalUrl} not found`,
        code: "ROUTE_NOT_FOUND"
    });
});
// Global error handler - MUST BE LAST
app.use((err, req, res, next) => {
    const requestId = req.id;
    console.error(`[${requestId}] Unhandled error:`, err);
    // Don't leak error details in production
    const isDev = process.env.NODE_ENV === 'development';
    // Check if response was already sent
    if (res.headersSent) {
        console.error(`[${requestId}] Error occurred after response was sent`);
        return;
    }
    // Database connection errors
    if (err.code === 'P2024' || err.code === 'P2034') {
        return res.status(503).json({
            error: "Service temporarily unavailable",
            code: "SERVICE_UNAVAILABLE",
            message: "The server is experiencing high load. Please try again.",
            requestId
        });
    }
    if (err.code === 'P1001' || err.code === 'P1002') {
        return res.status(503).json({
            error: "Database connection error",
            code: "DB_CONNECTION_ERROR",
            message: "Unable to connect to the database. Please try again.",
            requestId
        });
    }
    // Default error response
    res.status(500).json({
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        message: isDev ? err.message : undefined,
        stack: isDev ? err.stack : undefined,
        requestId
    });
});
// ============================================
// GRACEFUL SHUTDOWN WITH CONNECTION CLEANUP
// ============================================
const shutdown = async (signal) => {
    console.log(`\n${signal} received, starting graceful shutdown...`);
    const shutdownTimeout = setTimeout(() => {
        console.error('Graceful shutdown timeout, forcing exit');
        process.exit(1);
    }, 30000); // 30 second timeout
    try {
        // Kill any idle database transactions before shutdown
        console.log('Cleaning up idle database transactions...');
        try {
            await db.$queryRawUnsafe(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'idle in transaction'
      `);
            console.log('Idle transactions terminated');
        }
        catch (error) {
            console.error('Failed to kill idle transactions:', error);
        }
        // Stop accepting new connections
        console.log('Closing HTTP server...');
        await new Promise((resolve, reject) => {
            httpServer.close((err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
        console.log('HTTP server closed');
        // Close WebSocket server
        if (wss) {
            console.log('Closing WebSocket server...');
            await new Promise((resolve) => {
                wss.close(() => resolve());
            });
            console.log('WebSocket server closed');
        }
        // Stop reconciliation job
        if (reconciliationJob) {
            console.log('Stopping reconciliation job...');
            try {
                if (typeof reconciliationJob === 'function') {
                    reconciliationJob();
                }
            }
            catch (error) {
                console.error('Error stopping reconciliation job:', error);
            }
        }
        // Database will be closed by prisma.ts shutdown handler
        clearTimeout(shutdownTimeout);
        console.log('Graceful shutdown completed');
        process.exit(0);
    }
    catch (error) {
        console.error('Error during shutdown:', error);
        clearTimeout(shutdownTimeout);
        process.exit(1);
    }
};
// Register shutdown handlers
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Log but don't exit in production
    if (process.env.NODE_ENV === 'production') {
        // Try to recover
        console.error('Attempting to continue despite uncaught exception');
    }
    else {
        shutdown('uncaughtException');
    }
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit on unhandled rejection
    if (process.env.NODE_ENV === 'development') {
        console.error('Development mode: Consider fixing this unhandled rejection');
    }
});
// Start server
httpServer.listen(PORT, () => {
    console.log(`
╔═════════════════════════════════════════╗
║         Server Started Successfully     ║
╠═════════════════════════════════════════╣
║ Port:        ${PORT.toString().padEnd(27)}║
║ Environment: ${(process.env.NODE_ENV || 'development').padEnd(27)}║
║ Node:        ${process.version.padEnd(27)}║
║ Platform:    ${process.platform.padEnd(27)}║
║ PID:         ${process.pid.toString().padEnd(27)}║
║ Timeout:     ${(MAX_REQUEST_TIMEOUT + 'ms').padEnd(27)}║
╚═════════════════════════════════════════╝
  `);
    if (!process.env.DATABASE_URL) {
        console.warn('⚠️  WARNING: No DATABASE_URL environment variable set');
    }
    console.log('🛡️  Response Guard: Enabled (prevents double responses)');
    console.log('📊 Database Monitor: Available at /monitor/db-health');
    console.log('🔄 CORS: Dynamic domain authorization enabled');
    console.log(`🔄 CORS: Cache will refresh every ${CACHE_REFRESH_INTERVAL / 1000} seconds`);
    console.log('🔄 CORS: Localhost allowed:', process.env.ALLOW_LOCALHOST === 'true' ? 'Yes' : 'No');
    console.log('🔄 CORS: Strict mode:', process.env.STRICT_CORS === 'true' ? 'Yes (block unknown origins)' : 'No (allow with warning)');
    console.log(`⏱️  Request timeout: ${MAX_REQUEST_TIMEOUT}ms`);
    // Check database health on startup
    setTimeout(async () => {
        try {
            const metrics = await getDatabaseMetrics();
            if (metrics && typeof metrics === 'object' && 'idleTransactions' in metrics) {
                const idleCount = metrics.idleTransactions;
                if (idleCount > 0) {
                    console.warn(`⚠️  WARNING: ${idleCount} idle transactions detected on startup`);
                    console.warn('   Run: curl -X POST http://localhost:' + PORT + '/monitor/db-health/kill-idle');
                }
            }
        }
        catch (error) {
            console.error('Failed to check initial database health:', error);
        }
    }, 5000);
});
