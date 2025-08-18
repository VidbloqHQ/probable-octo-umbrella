export function singletonController(controllerName, controller) {
    return async (req, res, next) => {
        const executionKey = `${controllerName}_executed`;
        const executionId = Math.random().toString(36).substring(7);
        // Add more detailed logging
        console.log(`[Singleton] Checking ${controllerName} for request ${req.id}`);
        if (req[executionKey]) {
            console.error(`[Singleton] BLOCKING ${controllerName} - already executed!`);
            console.error(`  Request: ${req.method} ${req.path}`);
            console.error(`  Request ID: ${req.id}`);
            console.error(`  Previous execution: ${req[executionKey]}`);
            console.error(`  Attempted execution: ${executionId}`);
            return;
        }
        console.log(`[Singleton] Executing ${controllerName} (${executionId}) for request ${req.id}`);
        req[executionKey] = executionId;
        try {
            await controller(req, res, next);
            console.log(`[Singleton] Completed ${controllerName} (${executionId})`);
        }
        catch (error) {
            console.error(`[Singleton] Error in ${controllerName} (${executionId}):`, error);
            throw error;
        }
    };
}
