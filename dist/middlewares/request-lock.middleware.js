export function requestLockMiddleware(req, res, next) {
    let responseSent = false;
    const originalJson = res.json;
    const originalSend = res.send;
    res.json = function (body) {
        if (responseSent) {
            return res;
        }
        responseSent = true;
        return originalJson.call(res, body);
    };
    res.send = function (body) {
        if (responseSent) {
            return res;
        }
        responseSent = true;
        return originalSend.call(res, body);
    };
    next();
}
export function timeoutMiddleware(timeoutMs = 15000) {
    return (req, res, next) => {
        if (['/health', '/ready'].includes(req.path)) {
            return next();
        }
        const timeoutHandle = setTimeout(() => {
            if (!res.headersSent) {
                res.status(504).json({
                    error: "Request timeout",
                    code: "REQUEST_TIMEOUT"
                });
            }
        }, timeoutMs);
        res.on('finish', () => clearTimeout(timeoutHandle));
        res.on('close', () => clearTimeout(timeoutHandle));
        next();
    };
}
// import { Request, Response, NextFunction } from "express";
// export function requestLockMiddleware(req: Request, res: Response, next: NextFunction) {
//   const startTime = Date.now();
//   let responseSent = false;
//   let isInternalCall = false;
//   // Store original methods
//   const originalJson = res.json;
//   const originalSend = res.send;
//   const originalEnd = res.end;
//   // Wrap res.json
//   res.json = function(body?: any): Response {
//       // console.log("Request Lock Middleware Initialized", startTime);
//     if (responseSent) {
//       console.error(`[DUPLICATE] res.json called after response sent for ${req.method} ${req.path} at ${Date.now() - startTime}ms`);
//       console.trace();
//       return res;
//     }
//     responseSent = true;
//     isInternalCall = true; // Mark that we're about to call send internally
//     const result = originalJson.call(res, body);
//     isInternalCall = false;
//     return result;
//   };
//   // Wrap res.send
//   res.send = function(body?: any): Response {
//     // If this is called by res.json internally, don't count it as duplicate
//     if (isInternalCall) {
//       return originalSend.call(res, body);
//     }
//     if (responseSent) {
//       console.error(`[DUPLICATE] res.send called after response sent for ${req.method} ${req.path} at ${Date.now() - startTime}ms`);
//       console.trace();
//       return res;
//     }
//     responseSent = true;
//     return originalSend.call(res, body);
//   };
//   // Wrap res.end
//   res.end = function(...args: any[]): Response {
//     if (responseSent && !isInternalCall) {
//       console.error(`[DUPLICATE] res.end called after response sent for ${req.method} ${req.path}`);
//       return res;
//     }
//     responseSent = true;
//     return (originalEnd as any).apply(res, args);
//   };
//   // Clear timeout when response is sent
//   res.on('finish', () => {
//         // console.log("Request Lock Middleware ended", Date.now());
//     const timeoutHandle = (req as any).timeoutHandle;
//     if (timeoutHandle) {
//       clearTimeout(timeoutHandle);
//       (req as any).timeoutHandle = null;
//     }
//   });
//   next();
// }
// /**
//  * Improved timeout middleware
//  */
// export function timeoutMiddleware(timeoutMs: number = 15000) {
//   return (req: Request, res: Response, next: NextFunction) => {
//     // Skip timeout for specific endpoints
//     if (['/health', '/ready', '/monitor/db-health'].includes(req.path)) {
//       return next();
//     }
//     // Add abort controller to request
//     (req as any).abortController = new AbortController();
//     // Set up timeout handler
//     const timeoutHandle = setTimeout(() => {
//       if (res.headersSent) {
//         return; // Response already sent
//       }
//       console.error(`[TIMEOUT] Request timeout after ${timeoutMs}ms: ${req.method} ${req.path}`);
//       // Abort any ongoing operations
//       if ((req as any).abortController) {
//         (req as any).abortController.abort();
//       }
//       // Mark request as timed out
//       (req as any).timedOut = true;
//       // Send timeout response
//       try {
//         res.status(504).json({ 
//           error: "Request timeout - operation took too long",
//           code: "REQUEST_TIMEOUT",
//           timeout: timeoutMs,
//           path: req.path
//         });
//       } catch (err) {
//         console.error('[TIMEOUT] Failed to send timeout response:', err);
//       }
//     }, timeoutMs);
//     // Store timeout handle on request so it can be cleared
//     (req as any).timeoutHandle = timeoutHandle;
//     // Clear timeout when response is complete
//     res.on('finish', () => {
//       if ((req as any).timeoutHandle) {
//         clearTimeout((req as any).timeoutHandle);
//         (req as any).timeoutHandle = null;
//       }
//     });
//     res.on('close', () => {
//       if ((req as any).timeoutHandle) {
//         clearTimeout((req as any).timeoutHandle);
//         (req as any).timeoutHandle = null;
//       }
//     });
//     next();
//   };
// }
