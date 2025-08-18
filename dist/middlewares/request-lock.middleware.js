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
// Simpler approach - only wrap the lowest level
export function requestLockMiddleware(req, res, next) {
    let responseSent = false;
    const startTime = Date.now();
    const originalSend = res.send;
    const originalEnd = res.end;
    // Only wrap send (json calls send internally)
    res.send = function (body) {
        if (responseSent) {
            const elapsed = Date.now() - startTime;
            console.error(`[RequestLock] Blocking duplicate send for ${req.method} ${req.path} (request-id: ${req.id}) after ${elapsed}ms`);
            console.trace();
            return res;
        }
        responseSent = true;
        // Clear timeout if exists
        const timeoutHandle = req.timeoutHandle;
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
        return originalSend.call(res, body);
    };
    // Also wrap end for completeness
    res.end = function (...args) {
        if (responseSent) {
            return res;
        }
        responseSent = true;
        const timeoutHandle = req.timeoutHandle;
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
        return originalEnd.apply(res, args);
    };
    next();
}
