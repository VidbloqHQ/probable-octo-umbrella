import { PrismaClient } from "@prisma/client";
const globalForPrisma = global;
// Singleton pattern - CRITICAL for connection pool management
const prismaClientSingleton = () => {
    const isProduction = process.env.NODE_ENV === 'production';
    // Parse database URL to add pgbouncer parameters
    let databaseUrl = process.env.DATABASE_URL || '';
    // Add pgbouncer=true and connection pooling parameters if not present
    if (!databaseUrl.includes('pgbouncer=true')) {
        const separator = databaseUrl.includes('?') ? '&' : '?';
        databaseUrl = `${databaseUrl}${separator}pgbouncer=true&connection_limit=20&pool_timeout=10`;
    }
    console.log('Initializing Prisma Client', {
        environment: process.env.NODE_ENV || 'development',
        connectionPool: 'PgBouncer Transaction Mode',
        connectionLimit: '20' // Reduced from 97
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
        }
        catch (error) {
            console.error(`❌ Database connection attempt ${i + 1} failed:`, error);
            if (i === retries - 1)
                throw error;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}
// Connect eagerly with retry
connectWithRetry().catch(error => {
    console.error('Failed to connect to database after retries:', error);
});
// CRITICAL: Wrapper for queries with connection pool management
export async function executeQuery(queryFn, options = {}) {
    const { maxRetries = 2, timeout = 5000, // Reduced from 10000
    retryDelay = 500 } = options;
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // Create a promise that rejects after timeout
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Query timeout')), timeout);
            });
            // Race between query and timeout
            const result = await Promise.race([
                queryFn(),
                timeoutPromise
            ]);
            return result;
        }
        catch (error) {
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
            const delay = Math.min(retryDelay * Math.pow(2, attempt) + Math.random() * 200, 5000);
            console.log(`[Retry ${attempt + 1}/${maxRetries}] Query failed with ${error.code}, retrying in ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}
// NO TRANSACTIONS - Just return the operation
export async function executeTransaction(fn, options) {
    console.warn('executeTransaction called but transactions are disabled with PgBouncer');
    // Execute without transaction
    return fn(db);
}
// Optimized health check
export async function isDatabaseHealthy() {
    try {
        await db.$queryRawUnsafe('SELECT 1');
        return true;
    }
    catch (error) {
        console.error('Health check failed:', error.message);
        return false;
    }
}
// Get database metrics
export async function getDatabaseMetrics() {
    try {
        // For Supabase/PgBouncer, we can't get detailed stats
        const result = await db.$queryRaw `SELECT 1 as healthy`;
        return {
            provider: 'postgresql-pgbouncer',
            healthy: true,
            connectionLimit: 20,
            note: 'Using PgBouncer transaction pooling mode'
        };
    }
    catch (error) {
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
export function trackQuery(success, error) {
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
        console.log(`[Prisma Stats] Last hour: ${queryCount} queries, ${errorCount} errors (${((errorCount / queryCount) * 100).toFixed(2)}% error rate), ${poolExhaustedCount} pool exhausted`);
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
// Graceful shutdown
async function cleanup() {
    console.log('Disconnecting Prisma client...');
    try {
        await db.$disconnect();
        console.log('Prisma client disconnected successfully');
    }
    catch (error) {
        console.error('Error during Prisma disconnect:', error);
    }
}
// Register shutdown handlers only once
if (!globalForPrisma.prisma) {
    const signals = ['SIGTERM', 'SIGINT'];
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
// import { PrismaClient } from "@prisma/client";
// const globalForPrisma = global as unknown as { prisma?: PrismaClient };
// // Singleton pattern - CRITICAL for connection pool management
// const prismaClientSingleton = () => {
//   const isProduction = process.env.NODE_ENV === 'production';
//   console.log('Initializing Prisma Client', {
//     environment: process.env.NODE_ENV || 'development',
//     connectionType: 'Session Pooler',
//     connectionLimit: process.env.DATABASE_CONNECTION_LIMIT || '50'
//   });
//   return new PrismaClient({
//     log: isProduction 
//       ? ['error'] 
//       : ['error', 'warn'],
//     errorFormat: isProduction ? 'minimal' : 'pretty',
//   });
// };
// // Create single instance
// export const db = globalForPrisma.prisma ?? prismaClientSingleton();
// if (process.env.NODE_ENV !== "production") {
//   globalForPrisma.prisma = db;
// }
// // Connect eagerly to detect issues early
// db.$connect()
//   .then(() => {
//     console.log('✅ Database connected successfully');
//   })
//   .catch((error) => {
//     console.error('❌ Failed to connect to database:', error);
//   });
// // CRITICAL: Set statement timeout to prevent hanging queries
// db.$executeRawUnsafe('SET statement_timeout = 10000').catch(() => {
//   // Ignore error if this fails
// });
// // Wrapper for queries with retry logic and timeout
// export async function executeQuery<T>(
//   queryFn: () => Promise<T>,
//   options: {
//     maxRetries?: number;
//     timeout?: number;
//     retryDelay?: number;
//   } = {}
// ): Promise<T> {
//   const { 
//     maxRetries = 2,
//     timeout = 10000,
//     retryDelay = 500
//   } = options;
//   let lastError: any;
//   for (let attempt = 0; attempt < maxRetries; attempt++) {
//     try {
//       // Create abort controller for timeout
//       const controller = new AbortController();
//       const timeoutId = setTimeout(() => controller.abort(), timeout);
//       try {
//         const result = await queryFn();
//         clearTimeout(timeoutId);
//         return result;
//       } catch (error: any) {
//         clearTimeout(timeoutId);
//         // If it's a timeout, throw immediately
//         if (controller.signal.aborted) {
//           const timeoutError = new Error('Query timeout');
//           (timeoutError as any).code = 'TIMEOUT';
//           throw timeoutError;
//         }
//         throw error;
//       }
//     } catch (error: any) {
//       lastError = error;
//       // Errors that should trigger retry
//       const retryableCodes = [
//         'P2024', // Connection pool timeout
//         'P2034', // Transaction write conflict
//         'P1001', // Can't reach database server
//         'P1002', // Database server timeout
//         'P2010', // Query timeout
//         'TIMEOUT' // Our custom timeout
//       ];
//       const shouldRetry = retryableCodes.includes(error.code);
//       const isLastAttempt = attempt === maxRetries - 1;
//       if (!shouldRetry || isLastAttempt) {
//         throw error;
//       }
//       // Exponential backoff with jitter
//       const delay = Math.min(
//         retryDelay * Math.pow(2, attempt) + Math.random() * 200,
//         5000
//       );
//       console.log(`[Retry ${attempt + 1}/${maxRetries}] Query failed with ${error.code}, retrying in ${delay}ms`);
//       await new Promise(resolve => setTimeout(resolve, delay));
//     }
//   }
//   throw lastError;
// }
// // FIXED: Transaction wrapper that properly handles PgBouncer
// export async function executeTransaction<T>(
//   fn: (tx: any) => Promise<T>,
//   options: {
//     maxWait?: number;
//     timeout?: number;
//     isolationLevel?: any;
//     retries?: number;
//   } = {}
// ): Promise<T> {
//   const { 
//     maxWait = 2000,  // Reduced from 5000
//     timeout = 10000, // Reduced from 15000
//     isolationLevel,
//     retries = 1      // Reduced from 2 - transactions shouldn't retry much
//   } = options;
//   // IMPORTANT: For PgBouncer, we need to be very careful with transactions
//   let lastError: any;
//   for (let attempt = 0; attempt < retries; attempt++) {
//     try {
//       // Use interactive transactions with proper timeout
//       const result = await db.$transaction(
//         async (tx) => {
//           // Set a statement timeout for this transaction
//           await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 10000');
//           return await fn(tx);
//         },
//         {
//           maxWait,
//           timeout,
//           isolationLevel: isolationLevel || undefined
//         }
//       );
//       return result;
//     } catch (error: any) {
//       lastError = error;
//       // Don't retry on transaction-specific errors
//       if (error.code === 'P2028' || // Transaction already closed
//           error.code === 'P2034' || // Write conflict
//           attempt === retries - 1) {
//         throw error;
//       }
//       // Small delay before retry
//       await new Promise(resolve => setTimeout(resolve, 500));
//     }
//   }
//   throw lastError;
// }
// // Optimized health check
// export async function isDatabaseHealthy(): Promise<boolean> {
//   try {
//     const result = await db.$queryRawUnsafe<any[]>(
//       'SELECT 1 as healthy'
//     );
//     return true;
//   } catch (error: any) {
//     console.error('Health check failed:', error.message);
//     return false;
//   }
// }
// // Get database metrics with connection cleanup check
// export async function getDatabaseMetrics() {
//   try {
//     if (!process.env.DATABASE_URL?.includes('postgres')) {
//       return { provider: 'non-postgresql', healthy: await isDatabaseHealthy() };
//     }
//     const stats = await db.$queryRaw<any[]>`
//       SELECT 
//         (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) as total_connections,
//         (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') as active_connections,
//         (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle') as idle_connections,
//         (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction') as idle_in_transaction,
//         (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event IS NOT NULL) as waiting_connections
//     `;
//     const result = stats[0] as any;
//     // Log warning if too many idle in transaction
//     if (result.idle_in_transaction > 5) {
//       console.error(`⚠️ WARNING: ${result.idle_in_transaction} idle transactions detected!`);
//     }
//     return {
//       provider: 'postgresql',
//       ...result,
//       healthy: true,
//       connectionLimit: process.env.DATABASE_CONNECTION_LIMIT || 'not set',
//       warning: result.idle_in_transaction > 5 ? 'High number of idle transactions' : null
//     };
//   } catch (error: any) {
//     return {
//       provider: 'postgresql',
//       healthy: false,
//       error: error.message
//     };
//   }
// }
// // Connection pool monitoring
// let queryCount = 0;
// let errorCount = 0;
// let slowQueryCount = 0;
// let lastReset = Date.now();
// export function trackQuery(success: boolean, duration?: number) {
//   queryCount++;
//   if (!success) errorCount++;
//   if (duration && duration > 1000) slowQueryCount++;
//   // Reset counters every hour
//   const now = Date.now();
//   if (now - lastReset > 3600000) {
//     console.log(`[Prisma Stats] Last hour: ${queryCount} queries, ${errorCount} errors (${((errorCount/queryCount) * 100).toFixed(2)}% error rate), ${slowQueryCount} slow queries`);
//     queryCount = 0;
//     errorCount = 0;
//     slowQueryCount = 0;
//     lastReset = now;
//   }
// }
// // Get current stats
// export function getQueryStats() {
//   const runtime = Date.now() - lastReset;
//   return {
//     queryCount,
//     errorCount,
//     slowQueryCount,
//     errorRate: queryCount > 0 ? (errorCount / queryCount) : 0,
//     slowQueryRate: queryCount > 0 ? (slowQueryCount / queryCount) : 0,
//     runtimeMs: runtime,
//     averageQps: queryCount / (runtime / 1000)
//   };
// }
// // Periodic connection cleanup
// setInterval(async () => {
//   try {
//     // Check for idle transactions
//     const idleCheck = await db.$queryRaw<any[]>`
//       SELECT count(*) as idle_count 
//       FROM pg_stat_activity 
//       WHERE datname = current_database() 
//       AND state = 'idle in transaction'
//       AND state_change < NOW() - INTERVAL '30 seconds'
//     `;
//     const idleCount = (idleCheck[0] as any).idle_count;
//     if (idleCount > 0) {
//       console.warn(`Found ${idleCount} old idle transactions, cleaning up...`);
//       // Kill old idle transactions
//       await db.$executeRawUnsafe(`
//         SELECT pg_terminate_backend(pid)
//         FROM pg_stat_activity
//         WHERE datname = current_database()
//         AND state = 'idle in transaction'
//         AND state_change < NOW() - INTERVAL '30 seconds'
//       `);
//     }
//   } catch (error) {
//     console.error('Error in connection cleanup:', error);
//   }
// }, 60000); // Check every minute
// // Graceful shutdown
// async function cleanup() {
//   console.log('Disconnecting Prisma client...');
//   try {
//     await db.$disconnect();
//     console.log('Prisma client disconnected successfully');
//   } catch (error) {
//     console.error('Error during Prisma disconnect:', error);
//   }
// }
// // Register shutdown handlers only once
// if (!globalForPrisma.prisma) {
//   const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
//   signals.forEach(signal => {
//     process.once(signal, async () => {
//       console.log(`${signal} received`);
//       await cleanup();
//       process.exit(0);
//     });
//   });
//   process.once('beforeExit', async () => {
//     await cleanup();
//   });
// }
// // Export Prisma types
// export { Prisma } from "@prisma/client";
// export type { PrismaClient } from "@prisma/client";
