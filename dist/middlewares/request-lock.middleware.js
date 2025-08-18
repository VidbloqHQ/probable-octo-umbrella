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
/**
 * Middleware to prevent duplicate request processing
 * This ensures each request is only processed once even if handlers are called multiple times
 */
// MINIMAL approach - just track, don't block
export function requestLockMiddleware(req, res, next) {
    const startTime = Date.now();
    let sendCount = 0;
    // Just track calls, don't block
    const originalJson = res.json;
    const originalSend = res.send;
    res.json = function (body) {
        sendCount++;
        if (sendCount > 1) {
            console.error(`[WARNING] Multiple json calls (${sendCount}) for ${req.method} ${req.path} at ${Date.now() - startTime}ms`);
        }
        return originalJson.call(res, body);
    };
    res.send = function (body) {
        sendCount++;
        if (sendCount > 1) {
            console.error(`[WARNING] Multiple send calls (${sendCount}) for ${req.method} ${req.path} at ${Date.now() - startTime}ms`);
        }
        return originalSend.call(res, body);
    };
    next();
}
