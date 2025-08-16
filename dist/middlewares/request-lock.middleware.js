// middlewares/request-lock.middleware.ts
/**
 * Middleware to prevent duplicate request processing
 * This ensures each request is only processed once even if handlers are called multiple times
 */
export function requestLockMiddleware(req, res, next) {
    // Create a unique lock for this request
    const requestLock = {
        processing: false,
        completed: false,
        responsesSent: 0
    };
    // Attach to request
    req.requestLock = requestLock;
    // Track original response methods
    const originalJson = res.json;
    const originalSend = res.send;
    const originalStatus = res.status;
    // Create a flag to track if this specific response object has sent
    let thisResponseSent = false;
    // Wrap res.json to track sends
    res.json = function (body) {
        const lock = req.requestLock;
        if (thisResponseSent) {
            console.error(`[RequestLock] Blocking duplicate json send for ${req.method} ${req.path} (request-id: ${req.id})`);
            console.trace();
            return res;
        }
        if (lock.completed) {
            console.error(`[RequestLock] Request already completed, blocking json send for ${req.method} ${req.path}`);
            return res;
        }
        thisResponseSent = true;
        lock.completed = true;
        lock.responsesSent++;
        return originalJson.call(res, body);
    };
    // Wrap res.send similarly
    res.send = function (body) {
        const lock = req.requestLock;
        if (thisResponseSent) {
            console.error(`[RequestLock] Blocking duplicate send for ${req.method} ${req.path} (request-id: ${req.id})`);
            console.trace();
            return res;
        }
        if (lock.completed) {
            console.error(`[RequestLock] Request already completed, blocking send for ${req.method} ${req.path}`);
            return res;
        }
        thisResponseSent = true;
        lock.completed = true;
        lock.responsesSent++;
        return originalSend.call(res, body);
    };
    // Wrap res.status to chain properly
    res.status = function (code) {
        if (thisResponseSent) {
            console.error(`[RequestLock] Cannot set status after response sent for ${req.method} ${req.path}`);
            return res;
        }
        return originalStatus.call(res, code);
    };
    next();
}
/**
 * Controller wrapper that uses request lock
 */
export function safeController(controllerFn) {
    return async (req, res, next) => {
        const lock = req.requestLock;
        // Check if this request is already being processed
        if (lock && lock.processing) {
            console.warn(`[SafeController] Request already being processed: ${req.method} ${req.path} (request-id: ${req.id})`);
            return; // Don't process again
        }
        // Check if this request already completed
        if (lock && lock.completed) {
            console.warn(`[SafeController] Request already completed: ${req.method} ${req.path} (request-id: ${req.id})`);
            return; // Don't process again
        }
        // Mark as processing
        if (lock) {
            lock.processing = true;
        }
        try {
            await controllerFn(req, res, next);
        }
        catch (error) {
            // Only send error if response hasn't been sent
            if (!res.headersSent && lock && !lock.completed) {
                console.error(`[SafeController] Error in ${req.method} ${req.path}:`, error);
                res.status(500).json({
                    error: 'Internal server error',
                    requestId: req.id
                });
            }
        }
        finally {
            // Mark as no longer processing
            if (lock) {
                lock.processing = false;
            }
        }
    };
}
