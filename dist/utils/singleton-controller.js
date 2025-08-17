// utils/singleton-controller.ts
/**
 * Ensures a controller only executes once per request
 */
export function singletonController(controllerName, controller) {
    return async (req, res, next) => {
        const executionKey = `${controllerName}_executed`;
        const executionId = Math.random().toString(36).substring(7);
        // Check if already executed
        if (req[executionKey]) {
            console.warn(`[Singleton] ${controllerName} already executed for request ${req.id}`);
            console.warn(`  Previous execution: ${req[executionKey]}`);
            console.warn(`  Attempted execution: ${executionId}`);
            return; // Don't execute again
        }
        // Mark as executed
        req[executionKey] = executionId;
        // Execute the actual controller
        try {
            await controller(req, res, next);
        }
        catch (error) {
            // Let error bubble up to error handler
            throw error;
        }
    };
}
