// // middlewares/response-guard.middleware.ts
// import { Request, Response, NextFunction } from "express";

// /**
//  * Middleware to prevent ERR_HTTP_HEADERS_SENT errors
//  * Tracks if response has been sent and prevents double sends
//  */
// export function responseGuard(req: Request, res: Response, next: NextFunction) {
//   const originalSend = res.send;
//   const originalJson = res.json;
//   const originalStatus = res.status;
//   const originalRedirect = res.redirect;
  
//   let responseSent = false;
//   const requestPath = req.path;
//   const requestMethod = req.method;
  
//   // Helper to check if response can be sent
//   const canSendResponse = () => {
//     if (responseSent) {
//       console.error(`[ResponseGuard] Attempted to send response twice for ${requestMethod} ${requestPath}`);
//       console.trace(); // Log stack trace to find the issue
//       return false;
//     }
//     if (res.headersSent) {
//       console.error(`[ResponseGuard] Headers already sent for ${requestMethod} ${requestPath}`);
//       return false;
//     }
//     return true;
//   };
  
//   // Wrap res.send with proper typing
//   res.send = function(body?: any): Response {
//     if (!canSendResponse()) return res;
//     responseSent = true;
//     return originalSend.call(res, body);
//   };
  
//   // Wrap res.json with proper typing
//   res.json = function(body?: any): Response {
//     if (!canSendResponse()) return res;
//     responseSent = true;
//     return originalJson.call(res, body);
//   };
  
//   // Wrap res.status to chain properly
//   res.status = function(code: number): Response {
//     if (res.headersSent) {
//       console.error(`[ResponseGuard] Cannot set status ${code} - headers already sent for ${requestMethod} ${requestPath}`);
//       return res;
//     }
//     return originalStatus.call(res, code);
//   };
  
//   // Wrap res.redirect with all overloads handled
//   // Store the original function reference with proper typing
//   const originalRedirectFunc = originalRedirect as any;
  
//   // Create new redirect function that handles all cases
//   (res as any).redirect = function(...args: any[]): void {
//     if (!canSendResponse()) return;
//     responseSent = true;
    
//     // Handle different argument patterns
//     if (args.length === 1) {
//       // redirect(url)
//       return originalRedirectFunc.call(res, args[0]);
//     } else if (args.length === 2) {
//       if (typeof args[0] === 'number') {
//         // redirect(status, url)
//         return originalRedirectFunc.call(res, args[0], args[1]);
//       } else {
//         // redirect(url, status)
//         return originalRedirectFunc.call(res, args[0], args[1]);
//       }
//     } else {
//       // Fallback for any other case
//       return originalRedirectFunc.apply(res, args);
//     }
//   };
  
//   // Add response tracking
//   res.on('finish', () => {
//     if (!responseSent && res.statusCode !== 304 && res.statusCode !== 204) { 
//       // 304 is Not Modified, 204 is No Content - these are valid without body
//       if (res.statusCode >= 400) {
//         console.warn(`[ResponseGuard] Error response ${res.statusCode} finished without explicit send for ${requestMethod} ${requestPath}`);
//       }
//     }
//   });
  
//   // Track errors
//   res.on('error', (error) => {
//     console.error(`[ResponseGuard] Response error for ${requestMethod} ${requestPath}:`, error);
//   });
  
//   next();
// }

// /**
//  * Async error wrapper to catch unhandled promise rejections
//  */
// export function asyncHandler(fn: Function) {
//   return (req: Request, res: Response, next: NextFunction) => {
//     Promise.resolve(fn(req, res, next)).catch((error) => {
//       console.error('[AsyncHandler] Caught unhandled error:', error);
//       if (!res.headersSent) {
//         res.status(500).json({ 
//           error: 'Internal server error',
//           code: 'ASYNC_ERROR',
//           requestId: (req as any).id
//         });
//       }
//     });
//   };
// }

// /**
//  * Wrapper for async route handlers to prevent unhandled rejections
//  * Usage: app.get('/route', asyncRoute(async (req, res) => { ... }))
//  */
// export function asyncRoute(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
//   return (req: Request, res: Response, next: NextFunction) => {
//     fn(req, res, next).catch((error) => {
//       if (!res.headersSent) {
//         console.error(`[AsyncRoute] Error in ${req.method} ${req.path}:`, error);
//         res.status(500).json({
//           error: 'Internal server error',
//           code: 'ROUTE_ERROR',
//           requestId: (req as any).id,
//           message: process.env.NODE_ENV === 'development' ? error.message : undefined
//         });
//       } else {
//         console.error(`[AsyncRoute] Error after response sent in ${req.method} ${req.path}:`, error);
//       }
//     });
//   };
// }

// middlewares/response-guard.middleware.ts
import { Request, Response, NextFunction } from "express";

/**
 * Middleware to prevent ERR_HTTP_HEADERS_SENT errors
 * Tracks if response has been sent and prevents double sends
 */
export function responseGuard(req: Request, res: Response, next: NextFunction) {
  const originalSend = res.send;
  const originalJson = res.json;
  const originalStatus = res.status;
  const originalRedirect = res.redirect;
  const originalEnd = res.end;
  
  let responseSent = false;
  const requestPath = req.path;
  const requestMethod = req.method;
  const requestId = (req as any).id || 'no-id';
  
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
  res.send = function(body?: any): Response {
    if (!canSendResponse()) {
      console.error(`[ResponseGuard] Blocking duplicate send for ${requestMethod} ${requestPath}`);
      return res;
    }
    responseSent = true;
    return originalSend.call(res, body);
  };
  
  // Wrap res.json
  res.json = function(body?: any): Response {
    if (!canSendResponse()) {
      console.error(`[ResponseGuard] Blocking duplicate json for ${requestMethod} ${requestPath}`);
      return res;
    }
    responseSent = true;
    return originalJson.call(res, body);
  };
  
  // Wrap res.status to chain properly
  res.status = function(code: number): Response {
    if (res.headersSent) {
      console.error(`[ResponseGuard] Cannot set status ${code} - headers already sent for ${requestMethod} ${requestPath}`);
      return res;
    }
    return originalStatus.call(res, code);
  };
  
  // Wrap res.redirect
  (res as any).redirect = function(...args: any[]): void {
    if (!canSendResponse()) {
      console.error(`[ResponseGuard] Blocking duplicate redirect for ${requestMethod} ${requestPath}`);
      return;
    }
    responseSent = true;
    
    // Handle different argument patterns
    if (args.length === 1) {
      return (originalRedirect as any).apply(res, args);
    } else if (args.length === 2) {
      // Use apply to handle both (status, url) and (url, status) signatures safely
      return (originalRedirect as any).apply(res, args);
    } else {
      return (originalRedirect as any).apply(res, args);
    }
  };
  
  // Wrap res.end
  res.end = function(...args: any[]): Response {
    if (!canSendResponse()) {
      console.error(`[ResponseGuard] Blocking duplicate end for ${requestMethod} ${requestPath}`);
      return res;
    }
    responseSent = true;
    return (originalEnd as any).apply(res, args);
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
export function responseGuardDebugOnly(req: Request, res: Response, next: NextFunction) {
  const originalSend = res.send;
  const originalJson = res.json;
  const requestPath = req.path;
  const requestMethod = req.method;
  const requestId = (req as any).id || 'no-id';
  
  let callCount = 0;
  
  // Wrap res.send
  res.send = function(body?: any): Response {
    callCount++;
    if (callCount > 1) {
      console.error(`[ResponseGuard-Debug] Multiple send calls (${callCount}) for ${requestMethod} ${requestPath} (request-id: ${requestId})`);
      console.trace();
    }
    return originalSend.call(res, body);
  };
  
  // Wrap res.json
  res.json = function(body?: any): Response {
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
export function asyncHandler(fn: Function) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((error) => {
      console.error('[AsyncHandler] Caught unhandled error:', error);
      if (!res.headersSent) {
        res.status(500).json({ 
          error: 'Internal server error',
          code: 'ASYNC_ERROR',
          requestId: (req as any).id
        });
      }
    });
  };
}

/**
 * Wrapper for async route handlers to prevent unhandled rejections
 */
export function asyncRoute(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch((error) => {
      if (!res.headersSent) {
        console.error(`[AsyncRoute] Error in ${req.method} ${req.path}:`, error);
        res.status(500).json({
          error: 'Internal server error',
          code: 'ROUTE_ERROR',
          requestId: (req as any).id,
          message: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
      } else {
        console.error(`[AsyncRoute] Error after response sent in ${req.method} ${req.path}:`, error);
      }
    });
  };
}