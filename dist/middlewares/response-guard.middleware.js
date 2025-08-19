/**
 * Middleware to prevent ERR_HTTP_HEADERS_SENT errors
 * Tracks if response has been sent and prevents double sends
 */
export function responseGuard(req, res, next) {
    const originalSend = res.send;
    const originalJson = res.json;
    const originalStatus = res.status;
    const originalRedirect = res.redirect;
    const originalEnd = res.end;
    let responseSent = false;
    const requestPath = req.path;
    const requestMethod = req.method;
    const requestId = req.id || 'no-id';
    // Helper to check if response can be sent
    const canSendResponse = () => {
        if (responseSent) {
            console.error(`[ResponseGuard] Attempted to send response twice for ${requestMethod} ${requestPath} (request-id: ${requestId})`);
            console.error(`[ResponseGuard] Response was already marked as sent`);
            console.trace(); // Log stack trace to find the issue
            return false;
        }
        if (res.headersSent) {
            console.error(`[ResponseGuard] Headers already sent for ${requestMethod} ${requestPath} (request-id: ${requestId})`);
            console.error(`[ResponseGuard] This should not happen - responseSent=${responseSent}`);
            return false;
        }
        return true;
    };
    // Wrap res.send
    res.send = function (body) {
        if (!canSendResponse()) {
            console.error(`[ResponseGuard] Blocking duplicate send for ${requestMethod} ${requestPath}`);
            return res;
        }
        responseSent = true;
        return originalSend.call(res, body);
    };
    // Wrap res.json
    res.json = function (body) {
        if (!canSendResponse()) {
            console.error(`[ResponseGuard] Blocking duplicate json for ${requestMethod} ${requestPath}`);
            return res;
        }
        responseSent = true;
        return originalJson.call(res, body);
    };
    // Wrap res.status to chain properly
    res.status = function (code) {
        if (res.headersSent) {
            console.error(`[ResponseGuard] Cannot set status ${code} - headers already sent for ${requestMethod} ${requestPath}`);
            return res;
        }
        return originalStatus.call(res, code);
    };
    // Wrap res.redirect
    res.redirect = function (...args) {
        if (!canSendResponse()) {
            console.error(`[ResponseGuard] Blocking duplicate redirect for ${requestMethod} ${requestPath}`);
            return;
        }
        responseSent = true;
        // Handle different argument patterns
        if (args.length === 1) {
            return originalRedirect.apply(res, args);
        }
        else if (args.length === 2) {
            // Use apply to handle both (status, url) and (url, status) signatures safely
            return originalRedirect.apply(res, args);
        }
        else {
            return originalRedirect.apply(res, args);
        }
    };
    // Wrap res.end
    res.end = function (...args) {
        if (!canSendResponse()) {
            console.error(`[ResponseGuard] Blocking duplicate end for ${requestMethod} ${requestPath}`);
            return res;
        }
        responseSent = true;
        return originalEnd.apply(res, args);
    };
    // Add response tracking
    res.on('finish', () => {
        if (!responseSent && res.statusCode !== 304 && res.statusCode !== 204) {
            // 304 is Not Modified, 204 is No Content - these are valid without body
            if (res.statusCode >= 400) {
                console.warn(`[ResponseGuard] Error response ${res.statusCode} finished without explicit send for ${requestMethod} ${requestPath}`);
            }
        }
    });
    // Track errors
    res.on('error', (error) => {
        console.error(`[ResponseGuard] Response error for ${requestMethod} ${requestPath}:`, error);
    });
    next();
}
/**
 * Simpler version that just logs but doesn't block
 */
export function responseGuardDebugOnly(req, res, next) {
    const originalSend = res.send;
    const originalJson = res.json;
    const requestPath = req.path;
    const requestMethod = req.method;
    const requestId = req.id || 'no-id';
    let callCount = 0;
    // Wrap res.send
    res.send = function (body) {
        callCount++;
        if (callCount > 1) {
            console.error(`[ResponseGuard-Debug] Multiple send calls (${callCount}) for ${requestMethod} ${requestPath} (request-id: ${requestId})`);
            console.trace();
        }
        return originalSend.call(res, body);
    };
    // Wrap res.json
    res.json = function (body) {
        callCount++;
        if (callCount > 1) {
            console.error(`[ResponseGuard-Debug] Multiple json calls (${callCount}) for ${requestMethod} ${requestPath} (request-id: ${requestId})`);
            console.trace();
        }
        return originalJson.call(res, body);
    };
    next();
}
/**
 * Async error wrapper to catch unhandled promise rejections
 */
export function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch((error) => {
            console.error('[AsyncHandler] Caught unhandled error:', error);
            if (!res.headersSent) {
                res.status(500).json({
                    error: 'Internal server error',
                    code: 'ASYNC_ERROR',
                    requestId: req.id
                });
            }
        });
    };
}
/**
 * Wrapper for async route handlers to prevent unhandled rejections
 */
export function asyncRoute(fn) {
    return (req, res, next) => {
        fn(req, res, next).catch((error) => {
            if (!res.headersSent) {
                console.error(`[AsyncRoute] Error in ${req.method} ${req.path}:`, error);
                res.status(500).json({
                    error: 'Internal server error',
                    code: 'ROUTE_ERROR',
                    requestId: req.id,
                    message: process.env.NODE_ENV === 'development' ? error.message : undefined
                });
            }
            else {
                console.error(`[AsyncRoute] Error after response sent in ${req.method} ${req.path}:`, error);
            }
        });
    };
}
