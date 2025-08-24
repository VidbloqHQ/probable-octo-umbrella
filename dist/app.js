import express from "express";
import { createServer } from "http";
import { TenantRouter, UserRouter, StreamRouter, AgendaRouter, PaymentRouter, PollRouter, ParticipantRouter, QuizRouter, TenantMeRouter, ProgramRouter, MonitorRouter } from "./routes/index.js";
import { beaconHandler, authenticateTenant } from "./middlewares/index.js";
import { startEnhancedReconciliationJob } from "./services/participantReconciliation.js";
import createSocketServer from "./websocket.js";
import { isDatabaseHealthy, getDatabaseMetrics, db, executeQuery } from "./prisma.js";
import { getAuthStats } from "./middlewares/tenant-auth.middleware.js";
// Import Redis and rate limiting
import { isRedisHealthy, closeRedisConnection } from "./redis.js";
import { createRateLimiter } from "./middlewares/rate-limiter.middleware.js";
import { cacheMiddleware, cacheInvalidationMiddleware } from "./middlewares/cache.middleware.js";
const app = express();
const PORT = process.env.PORT || 8001;
const httpServer = createServer(app);
const MAX_REQUEST_TIMEOUT = Math.min(parseInt(process.env.MAX_REQUEST_TIMEOUT || '15000'), 15000);
export const wss = createSocketServer(httpServer);
// ============================================
// MEMORY AND HEALTH MONITORING
// ============================================
const serverStartTime = Date.now();
// Log memory usage every 30 seconds
setInterval(() => {
    const usage = process.memoryUsage();
    const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
    console.log(`[Health] Uptime: ${uptime}s | Memory: RSS=${Math.round(usage.rss / 1024 / 1024)}MB, Heap=${Math.round(usage.heapUsed / 1024 / 1024)}/${Math.round(usage.heapTotal / 1024 / 1024)}MB`);
    // Warn if memory is high
    if (usage.rss > 500 * 1024 * 1024) { // 500MB
        console.warn(`[Health] WARNING: High memory usage: ${Math.round(usage.rss / 1024 / 1024)}MB`);
    }
}, 30000);
// Trust proxy (important for Railway/Render/Heroku) - MUST BE FIRST
app.set('trust proxy', true);
// ============================================
// GLOBAL RATE LIMITER - MUST BE EARLY!
// ============================================
app.use(createRateLimiter());
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
 */
function normalizeOrigin(origin) {
    try {
        const url = new URL(origin);
        return url.hostname + (url.port ? ':' + url.port : '');
    }
    catch {
        return origin.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }
}
/**
 * Check if an origin is authorized for any tenant
 */
function isOriginAuthorized(origin) {
    const normalizedOrigin = normalizeOrigin(origin);
    for (const domains of authorizedDomainsCache.values()) {
        if (domains.has(normalizedOrigin)) {
            return true;
        }
    }
    return false;
}
// ============================================
// CUSTOM CORS MIDDLEWARE - MUST BE BEFORE BODY PARSER!
// ============================================
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (process.env.NODE_ENV === 'development') {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }
    else if (!origin) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    else {
        const isLocalhost = origin.includes('localhost') ||
            origin.includes('127.0.0.1') ||
            origin.includes('::1');
        if (isLocalhost && process.env.ALLOW_LOCALHOST === 'true') {
            res.setHeader('Access-Control-Allow-Origin', origin);
        }
        else if (isOriginAuthorized(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
        }
        else {
            const adminDomains = process.env.ADMIN_DOMAINS
                ? process.env.ADMIN_DOMAINS.split(',').map(o => o.trim())
                : [];
            if (adminDomains.length > 0 && adminDomains.some(allowed => origin.startsWith(allowed))) {
                res.setHeader('Access-Control-Allow-Origin', origin);
            }
            else {
                if (process.env.STRICT_CORS === 'true') {
                    console.warn(`CORS: Blocked unregistered origin: ${origin}`);
                }
                else {
                    console.log(`CORS: Allowing unregistered origin: ${origin} (consider adding to authorized domains)`);
                    res.setHeader('Access-Control-Allow-Origin', origin);
                }
            }
        }
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-api-secret, X-Requested-With, Accept, Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Access-Control-Expose-Headers', 'x-request-id, X-Total-Count, X-Page, X-Per-Page, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset');
    if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
    }
    next();
});
// ============================================
// BODY PARSER - AFTER CORS
// ============================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// ============================================
// REQUEST ID MIDDLEWARE
// ============================================
app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] ||
        `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    res.setHeader('x-request-id', req.id);
    next();
});
// ============================================
// REQUEST LOCK MIDDLEWARE - CRITICAL!
// Must be BEFORE all other response-modifying middleware
// ============================================
// app.use(requestLockMiddleware);
// ============================================
// TIMEOUT MIDDLEWARE
// ============================================
// app.use(timeoutMiddleware(MAX_REQUEST_TIMEOUT));
// ============================================
// REQUEST LOGGING (OPTIONAL)
// ============================================
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
// BEACON HANDLER
// ============================================
app.use(beaconHandler);
// ============================================
// MONITORING ENDPOINTS (NO AUTH)
// ============================================
app.use("/monitor", MonitorRouter.default);
// ============================================
// HEALTH CHECK ENDPOINT (NO AUTH) - WITH REDIS
// ============================================
app.get('/health', async (req, res) => {
    try {
        const [dbHealthy, dbMetrics, redisHealthy] = await Promise.all([
            isDatabaseHealthy(),
            getDatabaseMetrics(),
            isRedisHealthy()
        ]);
        const authStats = getAuthStats();
        const usage = process.memoryUsage();
        const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
        const issues = [];
        if (!redisHealthy) {
            issues.push('Redis is not healthy');
        }
        if (dbMetrics && typeof dbMetrics === 'object' && 'idleTransactions' in dbMetrics) {
            if (dbMetrics.idleTransactions > 5) {
                issues.push(`High idle transaction count: ${dbMetrics.idleTransactions}`);
            }
        }
        if (usage.rss > 500 * 1024 * 1024) {
            issues.push(`High memory usage: ${Math.round(usage.rss / 1024 / 1024)}MB`);
        }
        const status = {
            status: dbHealthy && redisHealthy && issues.length === 0 ? 'healthy' : 'unhealthy',
            timestamp: new Date().toISOString(),
            uptime: uptime,
            environment: process.env.NODE_ENV || 'development',
            database: {
                connected: dbHealthy,
                metrics: dbMetrics
            },
            redis: {
                connected: redisHealthy
            },
            auth: authStats,
            cors: {
                authorizedDomainsCount: Array.from(authorizedDomainsCache.values()).reduce((sum, set) => sum + set.size, 0),
                tenantsWithDomains: authorizedDomainsCache.size,
                lastCacheRefresh: lastCacheRefresh ? new Date(lastCacheRefresh).toISOString() : 'pending'
            },
            system: {
                uptime: process.uptime(),
                memory: {
                    rss: `${Math.round(usage.rss / 1024 / 1024)}MB`,
                    heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
                    heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
                    external: `${Math.round(usage.external / 1024 / 1024)}MB`
                },
                node: process.version,
                platform: process.platform,
                pid: process.pid
            },
            issues: issues.length > 0 ? issues : undefined
        };
        res.status(dbHealthy && redisHealthy ? 200 : 503).json(status);
    }
    catch (error) {
        console.error('Health check error:', error);
        res.status(503).json({
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});
// ============================================
// READINESS CHECK (NO AUTH)
// ============================================
app.get('/ready', async (req, res) => {
    try {
        const [dbReady, redisReady] = await Promise.all([
            isDatabaseHealthy(),
            isRedisHealthy()
        ]);
        const isReady = dbReady && redisReady;
        res.status(isReady ? 200 : 503).json({ ready: isReady });
    }
    catch (error) {
        res.status(503).json({ ready: false });
    }
});
// ============================================
// DELAY PARTICIPANT RECONCILIATION STARTUP
// ============================================
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
// ============================================
// PUBLIC ROUTES (NO AUTH REQUIRED)
// ============================================
app.use("/tenant", TenantRouter.default);
// ============================================
// PROTECTED ROUTES (AUTH REQUIRED)
// ============================================
app.use(authenticateTenant);
// Apply caching middleware to GET requests
app.use(cacheMiddleware());
// Apply cache invalidation middleware
app.use(cacheInvalidationMiddleware);
app.use("/tenant/me", TenantMeRouter.default);
app.use("/user", UserRouter.default);
app.use("/stream", StreamRouter.default);
app.use("/pay", PaymentRouter.default);
app.use("/agenda", AgendaRouter.default);
app.use("/poll", PollRouter.default);
app.use("/participant", ParticipantRouter.default);
app.use("/quiz", QuizRouter.default);
app.use("/program", ProgramRouter.default);
// ============================================
// LOG ALL REGISTERED ROUTES
// ============================================
// console.log('App initialization complete. Logging routes...');
// logAllRoutes(app);
// ============================================
// 404 HANDLER
// ============================================
app.all("*", (req, res) => {
    res.status(404).json({
        error: `Route ${req.originalUrl} not found`,
        code: "ROUTE_NOT_FOUND"
    });
});
// ============================================
// GLOBAL ERROR HANDLER - MUST BE LAST
// ============================================
app.use((err, req, res, next) => {
    const requestId = req.id;
    console.error(`[${requestId}] Unhandled error:`, err);
    const isDev = process.env.NODE_ENV === 'development';
    if (res.headersSent) {
        console.error(`[${requestId}] Error occurred after response was sent`);
        return;
    }
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
    console.log(`[SHUTDOWN] Memory at shutdown:`, process.memoryUsage());
    console.log(`[SHUTDOWN] Uptime: ${Math.floor((Date.now() - serverStartTime) / 1000)} seconds`);
    const shutdownTimeout = setTimeout(() => {
        console.error('Graceful shutdown timeout, forcing exit');
        process.exit(1);
    }, 30000);
    try {
        // Close Redis connections
        console.log('Closing Redis connections...');
        await closeRedisConnection();
        console.log('Redis connections closed');
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
        if (wss) {
            console.log('Closing WebSocket server...');
            await new Promise((resolve) => {
                wss.close(() => resolve());
            });
            console.log('WebSocket server closed');
        }
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
process.once('SIGTERM', () => {
    console.log('[SIGTERM] Received SIGTERM signal');
    shutdown('SIGTERM');
});
process.once('SIGINT', () => {
    console.log('[SIGINT] Received SIGINT signal');
    shutdown('SIGINT');
});
// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('[UncaughtException] Error:', error);
    console.error('[UncaughtException] Stack:', error.stack);
    if (process.env.NODE_ENV === 'production') {
        console.error('Attempting to continue despite uncaught exception');
    }
    else {
        shutdown('uncaughtException');
    }
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[UnhandledRejection] Promise:', promise);
    console.error('[UnhandledRejection] Reason:', reason);
    if (reason instanceof Error) {
        console.error('[UnhandledRejection] Stack:', reason.stack);
    }
    if (process.env.NODE_ENV === 'development') {
        console.error('Development mode: Consider fixing this unhandled rejection');
    }
});
// ============================================
// START SERVER
// ============================================
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
    if (!process.env.REDIS_HOST) {
        console.warn('⚠️  WARNING: No REDIS_HOST environment variable set - using localhost');
    }
    console.log('🛡️  Request Lock: Enabled (prevents duplicate responses)');
    console.log('🚦 Rate Limiting: Enabled (Redis-based)');
    console.log('💾 Response Caching: Enabled (Redis-based)');
    console.log('📊 Database Monitor: Available at /monitor/db-health');
    console.log('💾 Memory Monitor: Logging every 30 seconds');
    console.log('🔄 CORS: Dynamic domain authorization enabled');
    console.log(`🔄 CORS: Cache will refresh every ${CACHE_REFRESH_INTERVAL / 1000} seconds`);
    console.log('🔄 CORS: Localhost allowed:', process.env.ALLOW_LOCALHOST === 'true' ? 'Yes' : 'No');
    console.log('🔄 CORS: Strict mode:', process.env.STRICT_CORS === 'true' ? 'Yes (block unknown origins)' : 'No (allow with warning)');
    console.log(`⏱️  Request timeout: ${MAX_REQUEST_TIMEOUT}ms`);
    // Initial memory report
    const usage = process.memoryUsage();
    console.log(`💾 Initial Memory: RSS=${Math.round(usage.rss / 1024 / 1024)}MB, Heap=${Math.round(usage.heapUsed / 1024 / 1024)}/${Math.round(usage.heapTotal / 1024 / 1024)}MB`);
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
