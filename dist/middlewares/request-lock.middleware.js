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
        responsesSent: 0,
        startTime: Date.now()
    };
    // Attach to request
    req.requestLock = requestLock;
    // Track original response methods
    const originalJson = res.json;
    const originalSend = res.send;
    const originalStatus = res.status;
    const originalEnd = res.end;
    // Create a flag to track if this specific response object has sent
    let thisResponseSent = false;
    // Wrap res.json to track sends
    res.json = function (body) {
        const lock = req.requestLock;
        if (thisResponseSent || lock.completed) {
            const elapsed = Date.now() - lock.startTime;
            console.error(`[RequestLock] Blocking duplicate json send for ${req.method} ${req.path} (request-id: ${req.id}) after ${elapsed}ms`);
            console.trace();
            return res;
        }
        thisResponseSent = true;
        lock.completed = true;
        lock.responsesSent++;
        // Clear any pending timeout
        const timeoutHandle = req.timeoutHandle;
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            req.timeoutHandle = null;
        }
        return originalJson.call(res, body);
    };
    // Wrap res.send similarly
    res.send = function (body) {
        const lock = req.requestLock;
        if (thisResponseSent || lock.completed) {
            const elapsed = Date.now() - lock.startTime;
            console.error(`[RequestLock] Blocking duplicate send for ${req.method} ${req.path} (request-id: ${req.id}) after ${elapsed}ms`);
            console.trace();
            return res;
        }
        thisResponseSent = true;
        lock.completed = true;
        lock.responsesSent++;
        // Clear any pending timeout
        const timeoutHandle = req.timeoutHandle;
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            req.timeoutHandle = null;
        }
        return originalSend.call(res, body);
    };
    // Wrap res.end
    res.end = function (...args) {
        const lock = req.requestLock;
        if (thisResponseSent || lock.completed) {
            return res;
        }
        thisResponseSent = true;
        lock.completed = true;
        // Clear any pending timeout
        const timeoutHandle = req.timeoutHandle;
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            req.timeoutHandle = null;
        }
        return originalEnd.apply(res, args);
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
 * Improved timeout middleware that works with request lock
 */
export function timeoutMiddleware(timeoutMs = 15000) {
    return (req, res, next) => {
        // Skip timeout for specific endpoints
        if (['/health', '/ready', '/monitor/db-health'].includes(req.path)) {
            return next();
        }
        // Add abort controller to request
        req.abortController = new AbortController();
        // Set up timeout handler
        const timeoutHandle = setTimeout(() => {
            const lock = req.requestLock;
            // Check if response already sent
            if (lock && lock.completed) {
                return; // Response already sent, do nothing
            }
            if (res.headersSent) {
                return; // Headers already sent, do nothing
            }
            console.error(`[TIMEOUT] Request timeout after ${timeoutMs}ms: ${req.method} ${req.path}`);
            // Try to abort any ongoing operations
            if (req.abortController) {
                req.abortController.abort();
            }
            // Mark request as timed out
            req.timedOut = true;
            // Send timeout response
            try {
                res.status(504).json({
                    error: "Request timeout - operation took too long",
                    code: "REQUEST_TIMEOUT",
                    timeout: timeoutMs,
                    path: req.path
                });
            }
            catch (err) {
                console.error('[TIMEOUT] Failed to send timeout response:', err);
            }
        }, timeoutMs);
        // Store timeout handle on request so it can be cleared
        req.timeoutHandle = timeoutHandle;
        // Clear timeout when response is complete
        const cleanup = () => {
            if (req.timeoutHandle) {
                clearTimeout(req.timeoutHandle);
                req.timeoutHandle = null;
            }
        };
        res.on('finish', cleanup);
        res.on('close', cleanup);
        res.on('error', cleanup);
        next();
    };
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
        // Check if request timed out
        if (req.timedOut) {
            console.warn(`[SafeController] Request already timed out: ${req.method} ${req.path}`);
            return;
        }
        // Mark as processing
        if (lock) {
            lock.processing = true;
        }
        try {
            // Check abort signal before executing
            if (req.abortController?.signal?.aborted) {
                console.log(`[SafeController] Request aborted before execution: ${req.method} ${req.path}`);
                return;
            }
            await controllerFn(req, res, next);
        }
        catch (error) {
            // Only send error if response hasn't been sent
            if (!res.headersSent && lock && !lock.completed) {
                console.error(`[SafeController] Error in ${req.method} ${req.path}:`, error);
                if (error.code === 'TIMEOUT' || error.message === 'Query timeout') {
                    res.status(504).json({
                        error: 'Database query timeout',
                        message: 'The operation took too long. Please try again.',
                        requestId: req.id
                    });
                }
                else {
                    res.status(500).json({
                        error: 'Internal server error',
                        requestId: req.id
                    });
                }
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
