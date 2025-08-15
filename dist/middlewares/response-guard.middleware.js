/**
 * Middleware to prevent ERR_HTTP_HEADERS_SENT errors
 * Tracks if response has been sent and prevents double sends
 */
export function responseGuard(req, res, next) {
    const originalSend = res.send;
    const originalJson = res.json;
    const originalStatus = res.status;
    const originalRedirect = res.redirect;
    let responseSent = false;
    const requestPath = req.path;
    const requestMethod = req.method;
    // Helper to check if response can be sent
    const canSendResponse = () => {
        if (responseSent) {
            console.error(`[ResponseGuard] Attempted to send response twice for ${requestMethod} ${requestPath}`);
            console.trace(); // Log stack trace to find the issue
            return false;
        }
        if (res.headersSent) {
            console.error(`[ResponseGuard] Headers already sent for ${requestMethod} ${requestPath}`);
            return false;
        }
        return true;
    };
    // Wrap res.send with proper typing
    res.send = function (body) {
        if (!canSendResponse())
            return res;
        responseSent = true;
        return originalSend.call(res, body);
    };
    // Wrap res.json with proper typing
    res.json = function (body) {
        if (!canSendResponse())
            return res;
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
    // Wrap res.redirect with all overloads handled
    // Store the original function reference with proper typing
    const originalRedirectFunc = originalRedirect;
    // Create new redirect function that handles all cases
    res.redirect = function (...args) {
        if (!canSendResponse())
            return;
        responseSent = true;
        // Handle different argument patterns
        if (args.length === 1) {
            // redirect(url)
            return originalRedirectFunc.call(res, args[0]);
        }
        else if (args.length === 2) {
            if (typeof args[0] === 'number') {
                // redirect(status, url)
                return originalRedirectFunc.call(res, args[0], args[1]);
            }
            else {
                // redirect(url, status)
                return originalRedirectFunc.call(res, args[0], args[1]);
            }
        }
        else {
            // Fallback for any other case
            return originalRedirectFunc.apply(res, args);
        }
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
 * Usage: app.get('/route', asyncRoute(async (req, res) => { ... }))
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
