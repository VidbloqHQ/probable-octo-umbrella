import { PrismaClient } from "@prisma/client";

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

// Singleton pattern - CRITICAL for connection pool management
const prismaClientSingleton = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  
  console.log('Initializing Prisma Client', {
    environment: process.env.NODE_ENV || 'development',
    pooler: process.env.DATABASE_URL?.includes('pgbouncer=true') ? 'PgBouncer' : 'Direct',
    connectionLimit: process.env.DATABASE_CONNECTION_LIMIT || '50'
  });

  return new PrismaClient({
    log: isProduction 
      ? ['error'] 
      : ['error', 'warn'],
    errorFormat: isProduction ? 'minimal' : 'pretty',
    datasources: {
      db: {
        url: process.env.DATABASE_URL
      }
    }
  });
};

// Create single instance
export const db = globalForPrisma.prisma ?? prismaClientSingleton();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

// Connect eagerly to detect issues early
db.$connect()
  .then(() => {
    console.log('✅ Database connected successfully');
  })
  .catch((error) => {
    console.error('❌ Failed to connect to database:', error);
    // Don't exit - let the app try to recover
  });

// Wrapper for queries with retry logic and timeout
export async function executeQuery<T>(
  queryFn: () => Promise<T>,
  options: {
    maxRetries?: number;
    timeout?: number;
    retryDelay?: number;
  } = {}
): Promise<T> {
  const { 
    maxRetries = 2, // Reduce retries for faster failures
    timeout = 10000, // Reduce timeout from 30s to 10s
    retryDelay = 500 // Reduce initial delay
  } = options;

  let lastError: any;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timeoutError = new Error('Query timeout');
        (timeoutError as any).code = 'TIMEOUT';
        setTimeout(() => reject(timeoutError), timeout);
      });

      // Race between query and timeout
      const result = await Promise.race([queryFn(), timeoutPromise]);
      return result;
      
    } catch (error: any) {
      lastError = error;
      
      // Errors that should trigger retry
      const retryableCodes = [
        'P2024', // Connection pool timeout
        'P2034', // Transaction write conflict
        'P1001', // Can't reach database server
        'P1002', // Database server timeout
        'P2010', // Query timeout
        'TIMEOUT' // Our custom timeout
      ];
      
      const shouldRetry = retryableCodes.includes(error.code);
      const isLastAttempt = attempt === maxRetries - 1;

      if (!shouldRetry || isLastAttempt) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        retryDelay * Math.pow(2, attempt) + Math.random() * 200,
        5000 // Max 5 seconds
      );
      
      console.log(`[Retry ${attempt + 1}/${maxRetries}] Query failed with ${error.code}, retrying in ${delay}ms`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// Transaction wrapper with proper error handling
export async function executeTransaction<T>(
  fn: (tx: any) => Promise<T>,
  options: {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: any;
    retries?: number;
  } = {}
): Promise<T> {
  const { 
    maxWait = 5000, 
    timeout = 15000, // Reduce from 30s
    isolationLevel,
    retries = 2 // Reduce retries
  } = options;
  
  return executeQuery(
    () => db.$transaction(fn, { maxWait, timeout, isolationLevel }),
    { maxRetries: retries, timeout: timeout + 5000 }
  );
}

// Optimized health check
export async function isDatabaseHealthy(): Promise<boolean> {
  try {
    await executeQuery(
      () => db.$queryRaw`SELECT 1 as healthy`,
      { maxRetries: 1, timeout: 3000 } // Very quick health check
    );
    return true;
  } catch (error: any) {
    console.error('Health check failed:', error.message);
    return false;
  }
}

// Get database metrics (PostgreSQL specific)
export async function getDatabaseMetrics() {
  try {
    if (!process.env.DATABASE_URL?.includes('postgres')) {
      return { provider: 'non-postgresql', healthy: await isDatabaseHealthy() };
    }

    // Try to get connection stats
    const stats = await executeQuery(
      async () => {
        const result = await db.$queryRaw<any[]>`
          SELECT 
            (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) as total_connections,
            (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') as active_connections,
            (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle') as idle_connections,
            (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event IS NOT NULL) as waiting_connections
        `;
        return result[0];
      },
      { maxRetries: 1, timeout: 3000 }
    );

    return {
      provider: 'postgresql',
      ...stats,
      healthy: true,
      connectionLimit: process.env.DATABASE_CONNECTION_LIMIT || 'not set'
    };
  } catch (error: any) {
    // Might not have permissions for pg_stat_activity
    if (error.code === '42501') {
      return {
        provider: 'postgresql',
        healthy: await isDatabaseHealthy(),
        error: 'Insufficient permissions for detailed metrics'
      };
    }
    
    return {
      provider: 'postgresql',
      healthy: false,
      error: error.message
    };
  }
}

// Connection pool monitoring
let queryCount = 0;
let errorCount = 0;
let slowQueryCount = 0;
let lastReset = Date.now();

export function trackQuery(success: boolean, duration?: number) {
  queryCount++;
  if (!success) errorCount++;
  if (duration && duration > 1000) slowQueryCount++;
  
  // Reset counters every hour
  const now = Date.now();
  if (now - lastReset > 3600000) {
    console.log(`[Prisma Stats] Last hour: ${queryCount} queries, ${errorCount} errors (${((errorCount/queryCount) * 100).toFixed(2)}% error rate), ${slowQueryCount} slow queries`);
    queryCount = 0;
    errorCount = 0;
    slowQueryCount = 0;
    lastReset = now;
  }
}

// Get current stats
export function getQueryStats() {
  const runtime = Date.now() - lastReset;
  return {
    queryCount,
    errorCount,
    slowQueryCount,
    errorRate: queryCount > 0 ? (errorCount / queryCount) : 0,
    slowQueryRate: queryCount > 0 ? (slowQueryCount / queryCount) : 0,
    runtimeMs: runtime,
    averageQps: queryCount / (runtime / 1000)
  };
}

// Graceful shutdown
async function cleanup() {
  console.log('Disconnecting Prisma client...');
  try {
    await db.$disconnect();
    console.log('Prisma client disconnected successfully');
  } catch (error) {
    console.error('Error during Prisma disconnect:', error);
  }
}

// Register shutdown handlers only once
if (!globalForPrisma.prisma) {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  signals.forEach(signal => {
    process.once(signal, async () => {
      console.log(`${signal} received`);
      await cleanup();
      process.exit(0);
    });
  });

  process.once('beforeExit', async () => {
    await cleanup();
  });
}

// Export Prisma types
export { Prisma } from "@prisma/client";
export type { PrismaClient } from "@prisma/client";