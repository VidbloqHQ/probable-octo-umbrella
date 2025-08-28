import express from "express";
import { createServer } from "http";
import { TenantRouter, UserRouter, StreamRouter, AgendaRouter, PaymentRouter, PollRouter, ParticipantRouter, QuizRouter, TenantMeRouter, ProgramRouter, MonitorRouter, } from "./routes/index.js";
import { beaconHandler, authenticateTenant } from "./middlewares/index.js";
import { requestLockMiddleware, timeoutMiddleware, } from "./middlewares/request-lock.middleware.js";
import { startEnhancedReconciliationJob } from "./services/participantReconciliation.js";
import createSocketServer from "./websocket.js";
import { isDatabaseHealthy, getDatabaseMetrics, db, executeQuery, } from "./prisma.js";
import { getAuthStats } from "./middlewares/tenant-auth.middleware.js";
// Import Redis and rate limiting
import { isRedisHealthy, closeRedisConnection } from "./redis.js";
import { createRateLimiter } from "./middlewares/rate-limiter.middleware.js";
import { cacheMiddleware, cacheInvalidationMiddleware, } from "./middlewares/cache.middleware.js";
const app = express();
const PORT = process.env.PORT || 8001;
const httpServer = createServer(app);
const MAX_REQUEST_TIMEOUT = Math.min(parseInt(process.env.MAX_REQUEST_TIMEOUT || "15000"), 15000);
export const wss = createSocketServer(httpServer);
// ============================================
// DATABASE CONNECTION CLEANUP MIDDLEWARE
// ============================================
// Fix in app.ts
function dbCleanupMiddleware(req, res, next) {
    const criticalPaths = ["/stream/", "/tenant/me", "/participant/"];
    if (criticalPaths.some((path) => req.path.includes(path))) {
        db.$queryRawUnsafe(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'idle in transaction'
        AND state_change < NOW() - INTERVAL '2 seconds'
    `).catch(() => { });
    }
    next();
}
// ============================================
// MEMORY AND HEALTH MONITORING
// ============================================
const serverStartTime = Date.now();
// Log memory usage every 30 seconds
setInterval(() => {
    const usage = process.memoryUsage();
    const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
    console.log(`[Health] Uptime: ${uptime}s | Memory: RSS=${Math.round(usage.rss / 1024 / 1024)}MB, Heap=${Math.round(usage.heapUsed / 1024 / 1024)}/${Math.round(usage.heapTotal / 1024 / 1024)}MB`);
    if (usage.rss > 500 * 1024 * 1024) {
        // 500MB
        console.warn(`[Health] WARNING: High memory usage: ${Math.round(usage.rss / 1024 / 1024)}MB`);
    }
}, 30000);
// Trust proxy - MUST BE FIRST
app.set("trust proxy", true);
// ============================================
// CORS MIDDLEWARE - EARLY TO HANDLE OPTIONS
// ============================================
app.use((req, res, next) => {
    const origin = req.headers.origin;
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, x-api-secret, X-Requested-With, Accept, Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.setHeader("Access-Control-Expose-Headers", "x-request-id, X-Total-Count, X-Page, X-Per-Page, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset");
    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});
// ============================================
// BODY PARSER - AFTER CORS
// ============================================
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
// ============================================
// BYPASS TEST ENDPOINTS
// ============================================
app.post("/test-token-direct", async (req, res) => {
    console.log(`[DIRECT TEST] Hit at ${Date.now()}`);
    res.json({
        test: true,
        timestamp: Date.now(),
        message: "Direct response - no middleware",
    });
});
// Add a test endpoint that bypasses all your middleware
app.get('/test-direct', async (req, res) => {
    const start = Date.now();
    try {
        const result = await db.$queryRaw `SELECT COUNT(*) FROM "Stream"`;
        res.json({
            time: Date.now() - start,
            result
        });
    }
    catch (error) {
        res.status(500).json({
            error: error?.message,
            time: Date.now() - start
        });
    }
});
app.post("/stream/token-direct", async (req, res) => {
    const startTime = Date.now();
    try {
        // Extract API key from headers to get tenant dynamically
        const apiKey = req.headers["x-api-key"];
        const apiSecret = req.headers["x-api-secret"];
        if (!apiKey || !apiSecret) {
            return res.status(401).json({ error: "Missing API credentials" });
        }
        // Quick lookup tenant from API key (with timeout)
        const apiToken = await executeQuery(() => db.apiToken.findFirst({
            where: {
                key: apiKey,
                isActive: true,
            },
            select: {
                tenantId: true,
                secret: true,
            },
        }), { maxRetries: 1, timeout: 2000 });
        if (!apiToken) {
            return res.status(401).json({ error: "Invalid API credentials" });
        }
        // Import bcrypt for secret verification
        const bcrypt = await import("bcryptjs");
        const validSecret = await bcrypt.compare(apiSecret, apiToken.secret);
        if (!validSecret) {
            return res.status(401).json({ error: "Invalid API credentials" });
        }
        const { createStreamToken } = await import("./controllers/stream.controller.js");
        req.tenant = {
            id: apiToken.tenantId,
        };
        await createStreamToken(req, res);
        console.log(`[DIRECT TOKEN] Completed in ${Date.now() - startTime}ms`);
    }
    catch (error) {
        console.error("[DIRECT TOKEN] Error:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: "Direct token generation failed" });
        }
    }
});
// ============================================
// REQUEST ID MIDDLEWARE
// ============================================
app.use((req, res, next) => {
    req.id =
        req.headers["x-request-id"] ||
            `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    res.setHeader("x-request-id", req.id);
    next();
});
// ============================================
// RATE LIMITER - WITH BYPASS FOR TOKEN
// ============================================
app.use(createRateLimiter());
// ============================================
// REQUEST LOCK MIDDLEWARE
// ============================================
app.use(requestLockMiddleware);
// ============================================
// TIMEOUT MIDDLEWARE
// ============================================
app.use(timeoutMiddleware(MAX_REQUEST_TIMEOUT));
// ============================================
// DATABASE CLEANUP FOR CRITICAL PATHS
// ============================================
app.use(dbCleanupMiddleware);
// ============================================
// REQUEST LOGGING (OPTIONAL)
// ============================================
if (process.env.NODE_ENV !== "production" ||
    process.env.ENABLE_REQUEST_LOGGING === "true") {
    app.use((req, res, next) => {
        if (!["/health", "/ready", "/monitor/db-health"].includes(req.path)) {
            const start = Date.now();
            res.on("finish", () => {
                const duration = Date.now() - start;
                if (duration > 1000) {
                    console.warn(`[SLOW] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
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
// HEALTH CHECK ENDPOINT
// ============================================
app.get("/health", async (req, res) => {
    try {
        const [dbHealthy, dbMetrics, redisHealthy] = await Promise.all([
            isDatabaseHealthy(),
            getDatabaseMetrics(),
            isRedisHealthy(),
        ]);
        const authStats = getAuthStats();
        const usage = process.memoryUsage();
        const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
        const issues = [];
        if (!redisHealthy) {
            issues.push("Redis is not healthy");
        }
        if (dbMetrics &&
            typeof dbMetrics === "object" &&
            "idleTransactions" in dbMetrics) {
            if (dbMetrics.idleTransactions > 5) {
                issues.push(`High idle transaction count: ${dbMetrics.idleTransactions}`);
            }
        }
        if (usage.rss > 500 * 1024 * 1024) {
            issues.push(`High memory usage: ${Math.round(usage.rss / 1024 / 1024)}MB`);
        }
        res
            .status(dbHealthy && redisHealthy && issues.length === 0 ? 200 : 503)
            .json({
            status: dbHealthy && redisHealthy && issues.length === 0
                ? "healthy"
                : "unhealthy",
            timestamp: new Date().toISOString(),
            uptime: uptime,
            database: {
                connected: dbHealthy,
                metrics: dbMetrics,
            },
            redis: {
                connected: redisHealthy,
            },
            auth: authStats,
            issues: issues.length > 0 ? issues : undefined,
        });
    }
    catch (error) {
        console.error("Health check error:", error);
        res.status(503).json({
            status: "error",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
});
// ============================================
// READINESS CHECK
// ============================================
app.get("/ready", async (req, res) => {
    try {
        const [dbReady, redisReady] = await Promise.all([
            isDatabaseHealthy(),
            isRedisHealthy(),
        ]);
        res
            .status(dbReady && redisReady ? 200 : 503)
            .json({ ready: dbReady && redisReady });
    }
    catch (error) {
        res.status(503).json({ ready: false });
    }
});
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
// 404 HANDLER
// ============================================
app.all("*", (req, res) => {
    res.status(404).json({
        error: `Route ${req.originalUrl} not found`,
        code: "ROUTE_NOT_FOUND",
    });
});
// ============================================
// GLOBAL ERROR HANDLER
// ============================================
app.use((err, req, res, next) => {
    const requestId = req.id;
    console.error(`[${requestId}] Unhandled error:`, err);
    if (res.headersSent) {
        console.error(`[${requestId}] Error occurred after response was sent`);
        return;
    }
    if (err.code === "P2024" || err.code === "P2034") {
        return res.status(503).json({
            error: "Service temporarily unavailable",
            code: "SERVICE_UNAVAILABLE",
            message: "The server is experiencing high load. Please try again.",
            requestId,
        });
    }
    res.status(500).json({
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        requestId,
    });
});
// ============================================
// PARTICIPANT RECONCILIATION JOB
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
}, 10000);
// ============================================
// GRACEFUL SHUTDOWN
// ============================================
const shutdown = async (signal) => {
    console.log(`\n${signal} received, starting graceful shutdown...`);
    const shutdownTimeout = setTimeout(() => {
        console.error("Graceful shutdown timeout, forcing exit");
        process.exit(1);
    }, 30000);
    try {
        // Clean up database connections
        await db
            .$queryRawUnsafe(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'idle in transaction'
    `)
            .catch(() => { });
        await closeRedisConnection();
        await new Promise((resolve) => {
            httpServer.close(() => resolve());
        });
        if (wss) {
            await new Promise((resolve) => {
                wss.close(() => resolve());
            });
        }
        if (reconciliationJob && typeof reconciliationJob === "function") {
            reconciliationJob();
        }
        clearTimeout(shutdownTimeout);
        console.log("Graceful shutdown completed");
        process.exit(0);
    }
    catch (error) {
        console.error("Error during shutdown:", error);
        clearTimeout(shutdownTimeout);
        process.exit(1);
    }
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
// ============================================
// START SERVER
// ============================================
httpServer.listen(PORT, () => {
    console.log(`
╔═════════════════════════════════════════╗
║         Server Started Successfully     ║
╠═════════════════════════════════════════╣
║ Port:        ${PORT.toString().padEnd(27)}║
║ Environment: ${(process.env.NODE_ENV || "development").padEnd(27)}║
║ Node:        ${process.version.padEnd(27)}║
║ Platform:    ${process.platform.padEnd(27)}║
║ PID:         ${process.pid.toString().padEnd(27)}║
║ Timeout:     ${(MAX_REQUEST_TIMEOUT + "ms").padEnd(27)}║
╚═════════════════════════════════════════╝
  `);
    console.log("🛡️  Request Lock: Enabled");
    console.log("🚦 Rate Limiting: Enabled");
    console.log("💾 Response Caching: Enabled");
    console.log("🧹 DB Cleanup: Enabled for critical paths");
    console.log(`⏱️  Request timeout: ${MAX_REQUEST_TIMEOUT}ms`);
    // Check for idle transactions on startup
    setTimeout(async () => {
        try {
            const metrics = await getDatabaseMetrics();
            if (metrics &&
                typeof metrics === "object" &&
                "idleTransactions" in metrics) {
                const idleCount = metrics.idleTransactions;
                if (idleCount > 0) {
                    console.warn(`⚠️  WARNING: ${idleCount} idle transactions detected on startup`);
                    // Auto-clean them
                    await db.$queryRawUnsafe(`
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = current_database()
          AND state = 'idle in transaction'
`);
                    console.log("✅ Cleaned up idle transactions");
                }
            }
        }
        catch (error) {
            console.error("Failed to check initial database health:", error);
        }
    }, 5000);
});
