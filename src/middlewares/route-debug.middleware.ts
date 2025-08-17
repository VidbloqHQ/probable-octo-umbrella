import { Request, Response, NextFunction } from "express";

/**
 * Debug middleware to track route matches and find duplicates
 * Add this BEFORE your routes in app.ts to see what's happening
 */
export function routeDebugMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = (req as any).id;
  const routeStack = (req as any).routeStack || [];
  
  // Track this middleware call
  routeStack.push({
    path: req.path,
    method: req.method,
    timestamp: Date.now(),
    stack: new Error().stack?.split('\n')[2] // Get caller
  });
  
  (req as any).routeStack = routeStack;
  
  // Log if we see multiple route matches
  if (routeStack.length > 1) {
    console.warn(`[RouteDebug] Multiple route matches for ${req.method} ${req.path} (${requestId}):`);
    routeStack.forEach((r: any, i: number) => {
      console.warn(`  ${i + 1}. ${r.path} at ${r.timestamp}ms`);
    });
  }
  
  // Track when routes are actually executed
  const originalJson = res.json;
  res.json = function(body?: any): Response {
    if (routeStack.length > 1) {
      console.error(`[RouteDebug] DUPLICATE ROUTE EXECUTION DETECTED!`);
      console.error(`  Request: ${req.method} ${req.path}`);
      console.error(`  Routes matched: ${routeStack.length}`);
      console.error(`  Request ID: ${requestId}`);
    }
    return originalJson.call(res, body);
  };
  
  next();
}