import express, { Request, Response, NextFunction } from "express";
import { createServer } from "http";
import {
  TenantRouter,
  UserRouter,
  StreamRouter,
  AgendaRouter,
  PaymentRouter,
  PollRouter,
  ParticipantRouter,
  QuizRouter,
  TenantMeRouter,
  ProgramRouter,
  MonitorRouter,
  QArouter
} from "./routes/index.js";
import { beaconHandler, authenticateTenant } from "./middlewares/index.js";
import {
  requestLockMiddleware,
  timeoutMiddleware,
} from "./middlewares/request-lock.middleware.js";
import { startEnhancedReconciliationJob } from "./services/participantReconciliation.js";
import createSocketServer from "./websocket.js";
import {
  isDatabaseHealthy,
  getDatabaseMetrics,
  db,
  executeQuery,
} from "./prisma.js";
import { getAuthStats } from "./middlewares/tenant-auth.middleware.js";

// Import Redis and rate limiting
import { redisClient, isRedisHealthy, closeRedisConnection } from "./redis.js";
import { createRateLimiter } from "./middlewares/rate-limiter.middleware.js";
import {
  cacheMiddleware,
  cacheInvalidationMiddleware,
} from "./middlewares/cache.middleware.js";

const app = express();
const PORT = process.env.PORT || 8001;
const httpServer = createServer(app);
const MAX_REQUEST_TIMEOUT = Math.min(
  parseInt(process.env.MAX_REQUEST_TIMEOUT || "15000"),
  15000
);

export const wss = createSocketServer(httpServer);

// ============================================
// TIMING MIDDLEWARE FOR DEBUGGING
// ============================================
const requestTimings = new Map<string, any>();

// function logTiming(req: Request, stage: string) {
//   const reqId = (req as any).id || `${Date.now()}-${Math.random()}`;
  
//   if (!requestTimings.has(reqId)) {
//     requestTimings.set(reqId, {
//       start: Date.now(),
//       stages: [],
//       path: req.path,
//       method: req.method
//     });
//   }
  
//   const timing = requestTimings.get(reqId);
//   const elapsed = Date.now() - timing.start;
//   timing.stages.push({ stage, elapsed });
  
//   console.log(`[TIMING-${reqId}] ${stage}: ${elapsed}ms`);
  
//   // Clean up old timings
//   if (requestTimings.size > 100) {
//     const keys = Array.from(requestTimings.keys()).slice(0, 50);
//     keys.forEach(k => requestTimings.delete(k));
//   }
// }

// ============================================
// DATABASE CONNECTION CLEANUP MIDDLEWARE
// ============================================

function dbCleanupMiddleware(req: Request, res: Response, next: NextFunction) {
  const criticalPaths = ["/stream/", "/tenant/me", "/participant/"];

  if (criticalPaths.some((path) => req.path.includes(path))) {
    db.$queryRawUnsafe(
      `
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'idle in transaction'
        AND state_change < NOW() - INTERVAL '2 seconds'
    `
    ).catch(() => {});
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

  console.log(
    `[Health] Uptime: ${uptime}s | Memory: RSS=${Math.round(
      usage.rss / 1024 / 1024
    )}MB, Heap=${Math.round(usage.heapUsed / 1024 / 1024)}/${Math.round(
      usage.heapTotal / 1024 / 1024
    )}MB`
  );

  if (usage.rss > 500 * 1024 * 1024) {
    console.warn(
      `[Health] WARNING: High memory usage: ${Math.round(
        usage.rss / 1024 / 1024
      )}MB`
    );
  }
}, 30000);

// Trust proxy - MUST BE FIRST
app.set("trust proxy", true);

// ============================================
// STAGE 0: Initial request logging
// ============================================
app.use((req: Request, res: Response, next: NextFunction) => {
  (req as any).id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  // logTiming(req, "0-REQUEST_RECEIVED");
  
  // Log when response is sent
  const originalSend = res.send;
  const originalJson = res.json;
  
  res.send = function(body?: any) {
    // logTiming(req, "RESPONSE_SENT");
    return originalSend.call(res, body);
  };
  
  res.json = function(body?: any) {
    // logTiming(req, "RESPONSE_SENT");
    return originalJson.call(res, body);
  };
  
  next();
});

// ============================================
// CORS MIDDLEWARE - EARLY TO HANDLE OPTIONS
// ============================================
app.use((req: Request, res: Response, next: NextFunction) => {
  // logTiming(req, "1-CORS_START");
  const origin = req.headers.origin as string;

  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS, PATCH"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-api-key, x-api-secret, X-Requested-With, Accept, Origin"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "x-request-id, X-Total-Count, X-Page, X-Per-Page, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  // logTiming(req, "1-CORS_END");
  next();
});

// ============================================
// BODY PARSER - AFTER CORS
// ============================================
app.use((req: Request, res: Response, next: NextFunction) => {
  // logTiming(req, "2-BODY_PARSER_START");
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use((req: Request, res: Response, next: NextFunction) => {
  // logTiming(req, "2-BODY_PARSER_END");
  next();
});

// ============================================
// TEST ENDPOINTS (NO AUTH)
// ============================================
// app.get('/test-direct', async (req: Request, res: Response) => {
//   const start = Date.now();
//   console.log('[TEST-DIRECT] Starting direct DB test');
  
//   try {
//     const result = await db.$queryRaw`SELECT COUNT(*) as count FROM "Stream"`;
//     const time = Date.now() - start;
//     console.log(`[TEST-DIRECT] Query completed in ${time}ms`);
    
//     res.json({ 
//       time,
//       result,
//       message: 'Direct database query without middleware'
//     });
//   } catch (error: any) {
//     const time = Date.now() - start;
//     console.error(`[TEST-DIRECT] Query failed after ${time}ms:`, error.message);
    
//     res.status(500).json({ 
//       error: error.message,
//       time,
//       message: 'Direct database query failed'
//     });
//   }
// });

// app.post('/test-auth-timing', async (req: Request, res: Response) => {
//   const start = Date.now();
//   const apiKey = req.headers['x-api-key'] as string;
//   const apiSecret = req.headers['x-api-secret'] as string;
  
//   console.log('[TEST-AUTH] Testing authentication speed');
  
//   try {
//     const authStart = Date.now();
//     const apiToken = await db.apiToken.findUnique({
//       where: { key: apiKey },
//       select: {
//         id: true,
//         secret: true,
//         isActive: true,
//         tenantId: true
//       }
//     });
//     console.log(`[TEST-AUTH] DB query: ${Date.now() - authStart}ms`);
    
//     if (!apiToken) {
//       return res.status(401).json({ error: 'Invalid API key' });
//     }
    
//     const bcryptStart = Date.now();
//     const bcrypt = await import('bcryptjs');
//     const validSecret = await bcrypt.compare(apiSecret, apiToken.secret);
//     console.log(`[TEST-AUTH] Bcrypt compare: ${Date.now() - bcryptStart}ms`);
    
//     res.json({
//       totalTime: Date.now() - start,
//       dbQueryTime: Date.now() - authStart,
//       bcryptTime: Date.now() - bcryptStart,
//       valid: validSecret
//     });
//   } catch (error: any) {
//     res.status(500).json({ 
//       error: error.message,
//       time: Date.now() - start
//     });
//   }
// });

// ============================================
// REQUEST ID MIDDLEWARE
// ============================================


app.use((req: Request, res: Response, next) => {
  // logTiming(req, "3-REQUEST_ID");
  res.setHeader("x-request-id", (req as any).id);
  next();
});

// ============================================
// RATE LIMITER - WITH BYPASS FOR TOKEN
// ============================================
app.use((req: Request, res: Response, next: NextFunction) => {
  // logTiming(req, "4-RATE_LIMIT_START");
  next();
});

app.use(createRateLimiter());

app.use((req: Request, res: Response, next: NextFunction) => {
  // logTiming(req, "4-RATE_LIMIT_END");
  next();
});

// ============================================
// REQUEST LOCK MIDDLEWARE
// ============================================
app.use((req: Request, res: Response, next: NextFunction) => {
  // logTiming(req, "5-REQUEST_LOCK_START");
  next();
});

app.use(requestLockMiddleware);

app.use((req: Request, res: Response, next: NextFunction) => {
  // logTiming(req, "5-REQUEST_LOCK_END");
  next();
});

// ============================================
// TIMEOUT MIDDLEWARE
// ============================================
app.use((req: Request, res: Response, next: NextFunction) => {
  // logTiming(req, "6-TIMEOUT_START");
  next();
});

app.use(timeoutMiddleware(MAX_REQUEST_TIMEOUT));

app.use((req: Request, res: Response, next: NextFunction) => {
  // logTiming(req, "6-TIMEOUT_END");
  next();
});

// ============================================
// DATABASE CLEANUP FOR CRITICAL PATHS
// ============================================
app.use((req: Request, res: Response, next: NextFunction) => {
  // logTiming(req, "7-DB_CLEANUP");
  dbCleanupMiddleware(req, res, next);
});

// ============================================
// BEACON HANDLER
// ============================================
app.use((req: Request, res: Response, next: NextFunction) => {
  // logTiming(req, "8-BEACON_START");
  
  // beaconHandler is an array, not a function, so we need to handle it differently
  if (Array.isArray(beaconHandler)) {
    let index = 0;
    const runNext = (err?: any) => {
      if (err || index >= beaconHandler.length) {
        // logTiming(req, "8-BEACON_END");
        return next(err);
      }
      const handler = beaconHandler[index++];
      handler(req, res, runNext);
    };
    runNext();
  } else {
    // logTiming(req, "8-BEACON_END");
    next();
  }
});

// ============================================
// MONITORING ENDPOINTS (NO AUTH)
// ============================================
app.use("/monitor", MonitorRouter.default);

// ============================================
// HEALTH CHECK ENDPOINT
// ============================================
app.get("/health", async (req: Request, res: Response) => {
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
    if (
      dbMetrics &&
      typeof dbMetrics === "object" &&
      "idleTransactions" in dbMetrics
    ) {
      if ((dbMetrics as any).idleTransactions > 5) {
        issues.push(
          `High idle transaction count: ${(dbMetrics as any).idleTransactions}`
        );
      }
    }

    if (usage.rss > 500 * 1024 * 1024) {
      issues.push(
        `High memory usage: ${Math.round(usage.rss / 1024 / 1024)}MB`
      );
    }

    res
      .status(dbHealthy && redisHealthy && issues.length === 0 ? 200 : 503)
      .json({
        status:
          dbHealthy && redisHealthy && issues.length === 0
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
  } catch (error) {
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
app.get("/ready", async (req: Request, res: Response) => {
  try {
    const [dbReady, redisReady] = await Promise.all([
      isDatabaseHealthy(),
      isRedisHealthy(),
    ]);
    res
      .status(dbReady && redisReady ? 200 : 503)
      .json({ ready: dbReady && redisReady });
  } catch (error) {
    res.status(503).json({ ready: false });
  }
});

// ============================================
// PUBLIC ROUTES (NO AUTH REQUIRED)
// ============================================
app.use("/tenant", TenantRouter.default);

// ============================================
// AUTHENTICATION MIDDLEWARE WITH TIMING
// ============================================
app.use((req: Request, res: Response, next: NextFunction) => {
  // logTiming(req, "9-AUTH_START");
  
  // Wrap the next function to log when auth completes
  const originalNext = next;
  next = (err?: any) => {
    // logTiming(req, "9-AUTH_END");
    originalNext(err);
  };
  
  authenticateTenant(req as any, res, next);
});

// ============================================
// CACHE MIDDLEWARE
// ============================================
app.use((req: Request, res: Response, next: NextFunction) => {
  // logTiming(req, "10-CACHE_START");
  next();
});

app.use(cacheMiddleware());

app.use((req: Request, res: Response, next: NextFunction) => {
  // logTiming(req, "10-CACHE_END");
  next();
});

app.use(cacheInvalidationMiddleware);

// ============================================
// PROTECTED ROUTES (AUTH REQUIRED)
// ============================================
app.use((req: Request, res: Response, next: NextFunction) => {
  // logTiming(req, "11-ROUTING_START");
  next();
});

app.use("/tenant/me", TenantMeRouter.default);
app.use("/user", UserRouter.default);
app.use("/stream", StreamRouter.default);
app.use("/pay", PaymentRouter.default);
app.use("/agenda", AgendaRouter.default);
app.use("/poll", PollRouter.default);
app.use("/participant", ParticipantRouter.default);
app.use("/quiz", QuizRouter.default);
app.use("/program", ProgramRouter.default);
app.use("/qa", QArouter.default);

// ============================================
// 404 HANDLER
// ============================================
app.all("*", (req: Request, res: Response) => {
  res.status(404).json({
    error: `Route ${req.originalUrl} not found`,
    code: "ROUTE_NOT_FOUND",
  });
});

// ============================================
// GLOBAL ERROR HANDLER
// ============================================
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  const requestId = (req as any).id;
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
let reconciliationJob: any = null;
setTimeout(() => {
  console.log("Starting participant reconciliation job...");
  try {
    reconciliationJob = startEnhancedReconciliationJob();
  } catch (error) {
    console.error("Failed to start reconciliation job:", error);
  }
}, 10000);

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, starting graceful shutdown...`);

  const shutdownTimeout = setTimeout(() => {
    console.error("Graceful shutdown timeout, forcing exit");
    process.exit(1);
  }, 30000);

  try {
    // Clean up database connections
    await db
      .$queryRawUnsafe(
        `
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'idle in transaction'
    `
      )
      .catch(() => {});

    await closeRedisConnection();

    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });

    if (wss) {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    }

    if (reconciliationJob && typeof reconciliationJob === "function") {
      reconciliationJob();
    }

    clearTimeout(shutdownTimeout);
    console.log("Graceful shutdown completed");
    process.exit(0);
  } catch (error) {
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
╔═══════════════════════════════════════╗
║    Server Started (DEBUG MODE)         ║
╠═══════════════════════════════════════╣
║ Port:        ${PORT.toString().padEnd(27)}║
║ Environment: ${(process.env.NODE_ENV || "development").padEnd(27)}║
║ Node:        ${process.version.padEnd(27)}║
║ Platform:    ${process.platform.padEnd(27)}║
║ PID:         ${process.pid.toString().padEnd(27)}║
║ Timeout:     ${(MAX_REQUEST_TIMEOUT + "ms").padEnd(27)}║
╚═══════════════════════════════════════╝
  `);

  console.log("🔍 DEBUG TIMING ENABLED - Check logs for [TIMING-*] entries");
  console.log("🛡️  Request Lock: Enabled");
  console.log("🚦 Rate Limiting: Enabled");
  console.log("💾 Response Caching: Enabled");
  console.log("🧹 DB Cleanup: Enabled for critical paths");
  console.log(`⏱️  Request timeout: ${MAX_REQUEST_TIMEOUT}ms`);

  // Check for idle transactions on startup
  setTimeout(async () => {
    try {
      const metrics = await getDatabaseMetrics();
      if (
        metrics &&
        typeof metrics === "object" &&
        "idleTransactions" in metrics
      ) {
        const idleCount = (metrics as any).idleTransactions;
        if (idleCount > 0) {
          console.warn(
            `⚠️  WARNING: ${idleCount} idle transactions detected on startup`
          );
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
    } catch (error) {
      console.error("Failed to check initial database health:", error);
    }
  }, 5000);
});