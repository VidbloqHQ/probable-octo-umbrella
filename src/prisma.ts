import { PrismaClient } from "@prisma/client";

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

// Singleton pattern - CRITICAL for connection pool management
const prismaClientSingleton = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  
  // Parse database URL to add pgbouncer parameters
  let databaseUrl = process.env.DATABASE_URL || '';
  
  // Add pgbouncer=true and connection pooling parameters if not present
  if (!databaseUrl.includes('pgbouncer=true')) {
    const separator = databaseUrl.includes('?') ? '&' : '?';
    // REDUCED statement_timeout from 30000 to 10000
    databaseUrl = `${databaseUrl}${separator}pgbouncer=true&connection_limit=25&pool_timeout=10&statement_timeout=10000`;
  }
  
  console.log('Initializing Prisma Client', {
    environment: process.env.NODE_ENV || 'development',
    connectionPool: 'PgBouncer Transaction Mode',
    connectionLimit: '10',
    statementTimeout: '10 seconds'
  });

  return new PrismaClient({
    log: isProduction 
      ? ['error']
      : ['error', 'warn'],
    errorFormat: isProduction ? 'minimal' : 'pretty',
    datasources: {
      db: {
        url: databaseUrl
      }
    }
  });
};

// Create single instance
export const db = globalForPrisma.prisma ?? prismaClientSingleton();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

// Connect with retry logic
async function connectWithRetry(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await db.$connect();
      console.log('✅ Database connected successfully');
      return;
    } catch (error) {
      console.error(`❌ Database connection attempt ${i + 1} failed:`, error);
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// Connect eagerly with retry
connectWithRetry().catch(error => {
  console.error('Failed to connect to database after retries:', error);
});

// Connection pool manager with stricter limits
class QueryQueue {
  private queue: Array<() => void> = [];
  private activeQueries = 0;
  private maxConcurrent = 8; // Reduced from 15 to prevent exhaustion
  
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    while (this.activeQueries >= this.maxConcurrent) {
      await new Promise<void>(resolve => {
        this.queue.push(resolve);
      });
    }
    
    this.activeQueries++;
    
    try {
      return await fn();
    } finally {
      this.activeQueries--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
  
  getStats() {
    return {
      active: this.activeQueries,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent
    };
  }
}

const queryQueue = new QueryQueue();

// CRITICAL: Wrapper for queries with connection pool management
export async function executeQuery<T>(
  queryFn: () => Promise<T>,
  options: {
    maxRetries?: number;
    timeout?: number;
    retryDelay?: number;
  } = {}
): Promise<T> {
  const { 
    maxRetries = 2,
    timeout = 10000, // Default 10 seconds
    retryDelay = 500
  } = options;

  // Use the queue to limit concurrent queries
  return queryQueue.execute(async () => {
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Create a promise that rejects after timeout
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Query timeout')), timeout);
        });

        // Race between query and timeout
        const result = await Promise.race([
          queryFn(),
          timeoutPromise
        ]);
        
        return result as T;
      } catch (error: any) {
        lastError = error;
        
        // Log connection pool errors
        if (error.code === 'P2024') {
          console.error(`[Connection Pool] Exhausted at attempt ${attempt + 1}`);
        }
        
        // Errors that should trigger retry
        const retryableCodes = [
          'P2024', // Connection pool timeout
          'P2034', // Transaction write conflict
          'P1001', // Can't reach database server
          'P1002', // Database server timeout
          'TIMEOUT' // Our custom timeout
        ];
        
        const shouldRetry = retryableCodes.includes(error.code) || 
                            error.message === 'Query timeout';
        const isLastAttempt = attempt === maxRetries - 1;

        if (!shouldRetry || isLastAttempt) {
          throw error;
        }

        // Exponential backoff with jitter
        const delay = Math.min(
          retryDelay * Math.pow(2, attempt) + Math.random() * 200,
          5000
        );
        
        console.log(`[Retry ${attempt + 1}/${maxRetries}] Query failed with ${error.code}, retrying in ${delay}ms`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  });
}

// Export queue stats for monitoring
export function getQueueStats() {
  return queryQueue.getStats();
}

// Monitor queue status
setInterval(() => {
  const stats = queryQueue.getStats();
  if (stats.active > 5 || stats.queued > 0) {
    console.log('[Query Queue]', stats);
  }
}, 5000);

// IMPORTANT: No transactions with PgBouncer in transaction mode!
// This just executes the operation directly without a transaction
export async function executeTransaction<T>(
  fn: (tx: any) => Promise<T>,
  options?: any
): Promise<T> {
  console.warn('[WARNING] executeTransaction called but transactions are not supported with PgBouncer in transaction mode');
  console.warn('[WARNING] Executing operations without transaction wrapper');
  
  // Execute without transaction - operations should be designed to be atomic
  // or use compensation patterns
  return fn(db);
}

// Optimized health check
export async function isDatabaseHealthy(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT 1');
    return true;
  } catch (error: any) {
    console.error('Health check failed:', error.message);
    return false;
  }
}


export async function getDatabaseMetrics() {
  try {
    const idleTransactions = await db.$queryRaw<any[]>`
      SELECT count(*) as count, state 
      FROM pg_stat_activity 
      WHERE datname = current_database() 
        AND state = 'idle in transaction'
      GROUP BY state
    `;
    
    const poolStats = await db.$queryRaw<any[]>`
      SELECT count(*) as total_connections,
             sum(case when state = 'active' then 1 else 0 end) as active,
             sum(case when state = 'idle' then 1 else 0 end) as idle,
             sum(case when state = 'idle in transaction' then 1 else 0 end) as idle_in_transaction
      FROM pg_stat_activity
      WHERE datname = current_database()
    `;
    
    // Convert BigInt to number for JSON serialization
    const stats = poolStats[0] || {};
    const convertedPoolStats = {
      total_connections: Number(stats.total_connections || 0),
      active: Number(stats.active || 0),
      idle: Number(stats.idle || 0),
      idle_in_transaction: Number(stats.idle_in_transaction || 0)
    };
    
    const idleCount = idleTransactions.length > 0 
      ? Number(idleTransactions[0].count || 0)
      : 0;
    
    return {
      provider: 'postgresql-pgbouncer',
      healthy: true,
      connectionLimit: 10,
      poolStats: convertedPoolStats,
      idleTransactions: idleCount,
      note: 'Using PgBouncer transaction pooling mode - NO TRANSACTIONS'
    };
  } catch (error: any) {
    return {
      provider: 'postgresql-pgbouncer',
      healthy: false,
      error: error.message
    };
  }
}

// Connection pool monitoring
let queryCount = 0;
let errorCount = 0;
let poolExhaustedCount = 0;
let lastReset = Date.now();

export function trackQuery(success: boolean, error?: any) {
  queryCount++;
  if (!success) {
    errorCount++;
    if (error?.code === 'P2024') {
      poolExhaustedCount++;
    }
  }
  
  // Reset counters every hour
  const now = Date.now();
  if (now - lastReset > 3600000) {
    console.log(`[Prisma Stats] Last hour: ${queryCount} queries, ${errorCount} errors (${((errorCount/queryCount) * 100).toFixed(2)}% error rate), ${poolExhaustedCount} pool exhausted`);
    queryCount = 0;
    errorCount = 0;
    poolExhaustedCount = 0;
    lastReset = now;
  }
}

// Get current stats
export function getQueryStats() {
  const runtime = Date.now() - lastReset;
  return {
    queryCount,
    errorCount,
    poolExhaustedCount,
    errorRate: queryCount > 0 ? (errorCount / queryCount) : 0,
    poolExhaustedRate: queryCount > 0 ? (poolExhaustedCount / queryCount) : 0,
    runtimeMs: runtime,
    averageQps: queryCount / (runtime / 1000)
  };
}

// Graceful shutdown with connection cleanup
async function cleanup() {
  console.log('Disconnecting Prisma client...');
  try {
    // Kill any hanging queries before disconnecting
    await db.$queryRawUnsafe(`
      SELECT pg_cancel_backend(pid)
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND query_start < NOW() - INTERVAL '30 seconds'
    `).catch(() => {});
    
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
