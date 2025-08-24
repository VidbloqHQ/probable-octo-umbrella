export function requestLockMiddleware(req, res, next) {
    const startTime = Date.now();
    let responseSent = false;
    let isInternalCall = false;
    // Store original methods
    const originalJson = res.json;
    const originalSend = res.send;
    const originalEnd = res.end;
    // Wrap res.json
    res.json = function (body) {
        console.log("Request Lock Middleware Initialized", startTime);
        if (responseSent) {
            console.error(`[DUPLICATE] res.json called after response sent for ${req.method} ${req.path} at ${Date.now() - startTime}ms`);
            console.trace();
            return res;
        }
        responseSent = true;
        isInternalCall = true; // Mark that we're about to call send internally
        const result = originalJson.call(res, body);
        isInternalCall = false;
        return result;
    };
    // Wrap res.send
    res.send = function (body) {
        // If this is called by res.json internally, don't count it as duplicate
        if (isInternalCall) {
            return originalSend.call(res, body);
        }
        if (responseSent) {
            console.error(`[DUPLICATE] res.send called after response sent for ${req.method} ${req.path} at ${Date.now() - startTime}ms`);
            console.trace();
            return res;
        }
        responseSent = true;
        return originalSend.call(res, body);
    };
    // Wrap res.end
    res.end = function (...args) {
        if (responseSent && !isInternalCall) {
            console.error(`[DUPLICATE] res.end called after response sent for ${req.method} ${req.path}`);
            return res;
        }
        responseSent = true;
        return originalEnd.apply(res, args);
    };
    // Clear timeout when response is sent
    res.on('finish', () => {
        console.log("Request Lock Middleware ended", Date.now());
        const timeoutHandle = req.timeoutHandle;
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            req.timeoutHandle = null;
        }
    });
    next();
}
/**
 * Improved timeout middleware
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
            if (res.headersSent) {
                return; // Response already sent
            }
            console.error(`[TIMEOUT] Request timeout after ${timeoutMs}ms: ${req.method} ${req.path}`);
            // Abort any ongoing operations
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
        res.on('finish', () => {
            if (req.timeoutHandle) {
                clearTimeout(req.timeoutHandle);
                req.timeoutHandle = null;
            }
        });
        res.on('close', () => {
            if (req.timeoutHandle) {
                clearTimeout(req.timeoutHandle);
                req.timeoutHandle = null;
            }
        });
        next();
    };
}
