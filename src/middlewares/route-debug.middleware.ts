// middlewares/route-debug.middleware.ts

import { Request, Response, NextFunction } from "express";

/**
 * Enhanced debug middleware to track route matches and find duplicates
 */
export function routeDebugMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip health checks and monitor endpoints
  if (['/health', '/ready', '/monitor/db-health'].includes(req.path)) {
    return next();
  }
  
  const requestId = (req as any).id;
  
  // Initialize tracking
  if (!(req as any).routeDebugInfo) {
    (req as any).routeDebugInfo = {
      startTime: Date.now(),
      middlewareCount: 0,
      routeMatches: []
    };
    
    console.log(`[RouteDebug] NEW REQUEST: ${req.method} ${req.path} (${requestId})`);
  }
  
  const debugInfo = (req as any).routeDebugInfo;
  debugInfo.middlewareCount++;
  
  // Log every middleware/route hit
  console.log(`[RouteDebug] Middleware #${debugInfo.middlewareCount} for ${req.path} at ${Date.now() - debugInfo.startTime}ms`);
  
  // Track response sends
  const originalJson = res.json;
  const originalSend = res.send;
  let sendCount = 0;
  
  res.json = function(body?: any): Response {
    sendCount++;
    const elapsed = Date.now() - debugInfo.startTime;
    
    if (sendCount > 1) {
      console.error(`[RouteDebug] DUPLICATE JSON SEND #${sendCount}!`);
      console.error(`  Path: ${req.method} ${req.path}`);
      console.error(`  Request ID: ${requestId}`);
      console.error(`  Time: ${elapsed}ms`);
      console.error(`  Middleware count: ${debugInfo.middlewareCount}`);
      console.trace(); // Show stack trace
    } else {
      console.log(`[RouteDebug] First JSON send for ${req.path} at ${elapsed}ms`);
    }
    
    return originalJson.call(res, body);
  };
  
  res.send = function(body?: any): Response {
    sendCount++;
    const elapsed = Date.now() - debugInfo.startTime;
    
    if (sendCount > 1) {
      console.error(`[RouteDebug] DUPLICATE SEND #${sendCount}!`);
      console.error(`  Path: ${req.method} ${req.path}`);
      console.error(`  Request ID: ${requestId}`);
      console.error(`  Time: ${elapsed}ms`);
      console.error(`  Middleware count: ${debugInfo.middlewareCount}`);
      console.trace(); // Show stack trace
    } else {
      console.log(`[RouteDebug] First send for ${req.path} at ${elapsed}ms`);
    }
    
    return originalSend.call(res, body);
  };
  
  next();
}

/**
 * Log all registered routes in Express
 */
export function logAllRoutes(app: any) {
  console.log('\n========================================');
  console.log('REGISTERED ROUTES:');
  console.log('========================================');
  
  function printRoute(path: string[], layer: any) {
    if (layer.route) {
      layer.route.stack.forEach((routeLayer: any) => {
        const methods = Object.keys(layer.route.methods).join(', ').toUpperCase();
        const fullPath = path.concat(split(layer.route.path)).filter(Boolean).join('/');
        console.log(`  ${methods.padEnd(8)} /${fullPath}`);
      });
    } else if (layer.name === 'router' && layer.handle.stack) {
      layer.handle.stack.forEach((routerLayer: any) => {
        printRoute(path.concat(split(layer.regexp)), routerLayer);
      });
    }
  }
  
  function split(thing: any): string[] {
    if (typeof thing === 'string') {
      return thing.split('/');
    } else if (thing.fast_slash) {
      return [];
    } else {
      const match = thing.toString()
        .replace('\\/?', '')
        .replace('(?=\\/|$)', '$')
        .match(/^\/\^?(.*)?\$\/?$/);
      if (match) {
        return match[1]?.replace(/\\/g, '').split('/') || [];
      }
      return [];
    }
  }
  
  app._router.stack.forEach((layer: any) => {
    printRoute([], layer);
  });
  
  console.log('========================================\n');
}