import express, { Request, Response, NextFunction } from "express";
import { createServer } from "http";
import cors from "cors";
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
  ProgramRouter
} from "./routes/index.js";
import { beaconHandler, authenticateTenant } from "./middlewares/index.js";
import { startEnhancedReconciliationJob } from "./services/participantReconciliation.js";
import createSocketServer from "./websocket.js";
import { isDatabaseHealthy, getDatabaseMetrics } from "./prisma.js";
import { getAuthStats } from "./middlewares/tenant-auth.middleware.js";

const app = express();
const PORT = process.env.PORT || 8001;
const httpServer = createServer(app);
const MAX_REQUEST_TIMEOUT = parseInt(process.env.MAX_REQUEST_TIMEOUT || '30000');

export const wss = createSocketServer(httpServer);

// Body parser configuration
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Trust proxy (important for Railway/Render/Heroku)
app.set('trust proxy', true);

// Health check endpoint (no auth required)
app.get('/health', async (req: Request, res: Response) => {
  const [dbHealthy, dbMetrics] = await Promise.all([
    isDatabaseHealthy(),
    getDatabaseMetrics()
  ]);
  
  const authStats = getAuthStats();
  
  const status = {
    status: dbHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    database: {
      connected: dbHealthy,
      metrics: dbMetrics
    },
    auth: authStats,
    system: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      node: process.version,
      platform: process.platform
    }
  };
  
  res.status(dbHealthy ? 200 : 503).json(status);
});

// Readiness check (for container orchestration)
app.get('/ready', async (req: Request, res: Response) => {
  const isReady = await isDatabaseHealthy();
  res.status(isReady ? 200 : 503).json({ ready: isReady });
});

// CORS configuration
const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // In production, you might want to validate against a whitelist
    if (process.env.ALLOWED_ORIGINS) {
      const allowedOrigins = process.env.ALLOWED_ORIGINS.split(',');
      if (origin && !allowedOrigins.includes(origin)) {
        callback(new Error('Not allowed by CORS'));
        return;
      }
    }
    callback(null, true);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "x-api-key",
    "x-api-secret",
    "Authorization",
  ],
  credentials: true,
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.use(beaconHandler);

// Request logging middleware
if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_REQUEST_LOGGING === 'true') {
  app.use((req: Request, res: Response, next) => {
    if (!['/health', '/ready'].includes(req.path)) {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
      });
    }
    next();
  });
}

// Request timeout middleware
app.use((req: Request, res: Response, next) => {
  // Skip timeout for specific endpoints
  if (['/health', '/ready'].includes(req.path)) {
    return next();
  }

  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      console.error(`Request timeout: ${req.method} ${req.path}`);
      res.status(504).json({ 
        error: "Request timeout",
        code: "REQUEST_TIMEOUT",
        timeout: MAX_REQUEST_TIMEOUT
      });
    }
  }, MAX_REQUEST_TIMEOUT);

  // Clear timeout when response is sent
  const cleanup = () => {
    clearTimeout(timeout);
  };
  
  res.on('finish', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
  
  next();
});

// Request ID middleware for tracing
app.use((req: Request, res: Response, next) => {
  req.id = req.headers['x-request-id'] as string || 
           `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  res.setHeader('x-request-id', req.id);
  next();
});

// Delay participant reconciliation startup
let reconciliationJob: any = null;
setTimeout(() => {
  console.log("Starting participant reconciliation job...");
  reconciliationJob = startEnhancedReconciliationJob();
}, process.env.RECONCILIATION_DELAY ? parseInt(process.env.RECONCILIATION_DELAY) : 10000);

// Public routes
app.use("/tenant", TenantRouter.default);

// Protected routes
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
app.all("*", (req: Request, res: Response) => {
  res.status(404).json({ 
    error: `Route ${req.originalUrl} not found`,
    code: "ROUTE_NOT_FOUND"
  });
});

// Global error handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  const requestId = (req as any).id;
  console.error(`[${requestId}] Unhandled error:`, err);
  
  // Don't leak error details in production
  const isDev = process.env.NODE_ENV === 'development';
  
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
  
  // CORS errors
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      error: "CORS policy violation",
      code: "CORS_ERROR",
      requestId
    });
  }
  
  // Default error response
  if (!res.headersSent) {
    res.status(500).json({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
      message: isDev ? err.message : undefined,
      stack: isDev ? err.stack : undefined,
      requestId
    });
  }
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, starting graceful shutdown...`);
  
  const shutdownTimeout = setTimeout(() => {
    console.error('Graceful shutdown timeout, forcing exit');
    process.exit(1);
  }, 30000); // 30 second timeout
  
  try {
    // Stop accepting new connections
    console.log('Closing HTTP server...');
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    console.log('HTTP server closed');
    
    // Close WebSocket server
    if (wss) {
      console.log('Closing WebSocket server...');
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      console.log('WebSocket server closed');
    }
    
    // Stop reconciliation job
    if (reconciliationJob) {
      console.log('Stopping reconciliation job...');
      reconciliationJob();
    }
    
    // Database will be closed by prisma.ts shutdown handler
    
    clearTimeout(shutdownTimeout);
    console.log('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
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
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit on unhandled rejection in production
  if (process.env.NODE_ENV !== 'production') {
    shutdown('unhandledRejection');
  }
});

// Start server
httpServer.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║         Server Started Successfully     ║
╠════════════════════════════════════════╣
║ Port:        ${PORT.toString().padEnd(27)}║
║ Environment: ${(process.env.NODE_ENV || 'development').padEnd(27)}║
║ Node:        ${process.version.padEnd(27)}║
║ Platform:    ${process.platform.padEnd(27)}║
║ PID:         ${process.pid.toString().padEnd(27)}║
╚════════════════════════════════════════╝
  `);
  
  if (!process.env.DATABASE_URL) {
    console.warn('⚠️  WARNING: No DATABASE_URL environment variable set');
  }
});

// Add TypeScript declaration for request ID
declare global {
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}
// import express, { Request, Response } from "express";
// import { createServer } from "http";
// import cors from "cors";
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
//   ProgramRouter
// } from "./routes/index.js";
// import { beaconHandler, authenticateTenant } from "./middlewares/index.js";
// import { startEnhancedReconciliationJob } from "./services/participantReconciliation.js";
// import createSocketServer from "./websocket.js";

// const app = express();
// const PORT = 8001;
// const httpServer = createServer(app);

// export const wss = createSocketServer(httpServer);

// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));


// const corsOptions = {
//   origin: function (
//     origin: string | undefined,
//     callback: (err: Error | null, allow?: boolean) => void
//   ) {
//     // Always allow preflight requests from any origin
//     // The actual API requests will be filtered by the tenant auth middleware
//     callback(null, true);
//   },
//   methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
//   allowedHeaders: [
//     "Content-Type",
//     "x-api-key",
//     "x-api-secret",
//     "Authorization",
//   ],
//   credentials: true,
//   maxAge: 86400, // Cache preflight response for 24 hours
// };

// app.use(cors(corsOptions));


// app.use(beaconHandler);
// app.options('*', cors(corsOptions));
// // Add body logging middleware for debugging
// app.use((req: Request, res: Response, next) => {
//   // console.log(req)
//   // console.log(`Request received: ${req.method} ${req.url}`);
//   next();
// });

// // Start the enhanced reconciliation job
// startEnhancedReconciliationJob();

// app.use("/tenant", TenantRouter.default);

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

// app.all("*", (req: Request, res: Response) => {
//   res.status(404).json({ error: `Route ${req.originalUrl} not found` });
// });

// httpServer.listen(PORT, () => {
//   console.log(`Server is listening on port ${PORT}`);
// });