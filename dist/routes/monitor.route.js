// routes/monitor.routes.ts
import { Router } from "express";
import { db, getDatabaseMetrics, getQueryStats, getQueueStats } from "../prisma.js";
const router = Router();
/**
 * Helper to convert BigInt to string for JSON serialization
 */
function serializeBigInt(obj) {
    if (obj === null || obj === undefined)
        return obj;
    if (typeof obj === 'bigint')
        return obj.toString();
    if (Array.isArray(obj))
        return obj.map(serializeBigInt);
    if (typeof obj === 'object') {
        const result = {};
        for (const key in obj) {
            result[key] = serializeBigInt(obj[key]);
        }
        return result;
    }
    return obj;
}
/**
 * Database health monitoring endpoint
 * Shows connection pool status and identifies issues
 */
router.get('/db-health', async (req, res) => {
    try {
        // Get connection pool status with BigInt handling
        const rawPoolStatus = await db.$queryRaw `
      SELECT 
        datname,
        pid,
        usename,
        application_name,
        client_addr::text as client_addr,
        state,
        state_change,
        query_start,
        wait_event,
        backend_type,
        CASE 
          WHEN state = 'idle in transaction' THEN 
            EXTRACT(EPOCH FROM (NOW() - state_change))::int 
          ELSE NULL 
        END as idle_in_transaction_seconds,
        LEFT(query, 100) as query_preview
      FROM pg_stat_activity
      WHERE datname = current_database()
      ORDER BY 
        CASE state 
          WHEN 'idle in transaction' THEN 0
          WHEN 'active' THEN 1
          WHEN 'idle' THEN 2
          ELSE 3
        END,
        state_change DESC
    `;
        // Serialize BigInt values
        const poolStatus = serializeBigInt(rawPoolStatus);
        // Group by state
        const stateGroups = poolStatus.reduce((acc, conn) => {
            const state = conn.state || 'other';
            if (!acc[state])
                acc[state] = [];
            acc[state].push({
                pid: conn.pid,
                duration: conn.idle_in_transaction_seconds,
                application: conn.application_name,
                query_preview: conn.query_preview
            });
            return acc;
        }, {});
        // Get metrics
        const [dbMetrics, queryStats, queueStats] = await Promise.all([
            getDatabaseMetrics(),
            getQueryStats(),
            getQueueStats()
        ]);
        // Identify issues
        const issues = [];
        const idleInTransactionCount = stateGroups['idle in transaction']?.length || 0;
        if (idleInTransactionCount > 5) {
            issues.push({
                severity: 'HIGH',
                issue: `${idleInTransactionCount} idle transactions detected`,
                action: 'Kill idle transactions using the provided SQL command'
            });
        }
        if (queryStats.errorRate > 0.1) {
            issues.push({
                severity: 'MEDIUM',
                issue: `High error rate: ${(queryStats.errorRate * 100).toFixed(2)}%`,
                action: 'Review error logs and optimize failing queries'
            });
        }
        if (queueStats.queued > 10) {
            issues.push({
                severity: 'HIGH',
                issue: `${queueStats.queued} queries queued`,
                action: 'Connection pool may be exhausted'
            });
        }
        // Provide fix commands if issues exist
        const fixes = [];
        if (idleInTransactionCount > 0) {
            fixes.push({
                description: 'Kill idle transactions',
                sql: `SELECT pg_terminate_backend(pid) 
FROM pg_stat_activity 
WHERE datname = current_database() 
  AND state = 'idle in transaction' 
  AND state_change < NOW() - INTERVAL '5 minutes';`
            });
        }
        const response = {
            status: issues.length === 0 ? 'healthy' : 'unhealthy',
            timestamp: new Date().toISOString(),
            connections: {
                total: poolStatus.length,
                byState: Object.keys(stateGroups).map(state => ({
                    state,
                    count: stateGroups[state].length,
                    connections: state === 'idle in transaction' ? stateGroups[state] : undefined
                }))
            },
            metrics: {
                database: serializeBigInt(dbMetrics),
                queries: queryStats,
                queue: queueStats
            },
            issues,
            fixes: fixes.length > 0 ? fixes : undefined
        };
        // Send response only once
        res.json(response);
    }
    catch (error) {
        console.error('Database health check failed:', error);
        // Only send error if response hasn't been sent
        if (!res.headersSent) {
            res.status(503).json({
                status: 'error',
                error: error instanceof Error ? error.message : 'Unknown error',
                details: process.env.NODE_ENV === 'development' ? error : undefined
            });
        }
    }
});
/**
 * Kill idle transactions endpoint (emergency use)
 */
router.post('/db-health/kill-idle', async (req, res) => {
    try {
        const { minIdleMinutes = 5 } = req.body;
        // Use parameterized query to avoid SQL injection
        const result = await db.$queryRaw `
      SELECT pg_terminate_backend(pid) as terminated, pid
      FROM pg_stat_activity 
      WHERE datname = current_database()
        AND state = 'idle in transaction'
        AND state_change < NOW() - INTERVAL ${minIdleMinutes + ' minutes'}
    `;
        const serializedResult = serializeBigInt(result);
        res.json({
            message: 'Idle transactions terminated',
            terminated: serializedResult.length,
            pids: serializedResult.map((r) => r.pid)
        });
    }
    catch (error) {
        console.error('Failed to kill idle transactions:', error);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Failed to kill idle transactions',
                details: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    }
});
/**
 * Simple health check endpoint
 */
router.get('/db-simple', async (req, res) => {
    try {
        const result = await db.$queryRaw `
      SELECT 
        state,
        COUNT(*) as count
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY state
      ORDER BY count DESC
    `;
        const serialized = serializeBigInt(result);
        res.json({
            status: 'ok',
            connections: serialized,
            timestamp: new Date().toISOString()
        });
    }
    catch (error) {
        console.error('Simple health check failed:', error);
        if (!res.headersSent) {
            res.status(503).json({
                status: 'error',
                error: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    }
});
export default router;
