// middlewares/cors.middleware.ts
import { Request, Response, NextFunction } from 'express';

/**
 * Simple CORS middleware as a fallback
 * Use this if the cors package is still giving issues
 */
export const simpleCors = (req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin || '*';
  
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-api-secret, X-Requested-With, Accept, Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Access-Control-Expose-Headers', 'x-request-id');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  
  next();
};

/**
 * Alternative approach using the app.ts directly
 * Add this at the VERY TOP of your app.ts file, right after creating the app
 */
export const setupCorsManually = (app: any) => {
  // This should be the FIRST middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    
    // List of allowed origins
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001', 
      'https://thestreamlink.com',
      // Add your production domains here
    ];
    
    // Allow the origin if it's in the list or if there's no origin (server-to-server)
    if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV === 'development') {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }
    
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-api-secret, X-Requested-With, Accept, Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');
    
    // Handle OPTIONS method
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    
    next();
  });
};