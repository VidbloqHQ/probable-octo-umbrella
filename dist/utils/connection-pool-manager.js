import { executeQuery } from "../prisma.js";
class ConnectionPoolManager {
    activeQueries = new Set();
    maxConcurrent = 15; // Limit concurrent queries
    queue = [];
    async executeManaged(queryFn, queryId = Math.random().toString(36)) {
        // Wait if too many concurrent queries
        while (this.activeQueries.size >= this.maxConcurrent) {
            await new Promise(resolve => {
                this.queue.push(resolve);
            });
        }
        this.activeQueries.add(queryId);
        try {
            const result = await queryFn();
            return result;
        }
        finally {
            this.activeQueries.delete(queryId);
            // Process queue
            const next = this.queue.shift();
            if (next) {
                next();
            }
        }
    }
    getStats() {
        return {
            activeQueries: this.activeQueries.size,
            queueLength: this.queue.length,
            maxConcurrent: this.maxConcurrent
        };
    }
    // Emergency release all
    releaseAll() {
        this.activeQueries.clear();
        this.queue.forEach(resolve => resolve());
        this.queue = [];
    }
}
export const poolManager = new ConnectionPoolManager();
// Wrapper for managed queries
export async function managedQuery(queryFn, options = {}) {
    return poolManager.executeManaged(() => executeQuery(queryFn, options));
}
// Monitor pool status
setInterval(() => {
    const stats = poolManager.getStats();
    if (stats.activeQueries > 10 || stats.queueLength > 0) {
        console.log('[Pool Manager]', stats);
    }
}, 5000);
export default poolManager;
