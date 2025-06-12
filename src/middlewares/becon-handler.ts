import { Request, Response, NextFunction } from "express";
import multer from "multer";

// Configure multer to parse multipart/form-data
const upload = multer();

/**
 * Middleware to handle sendBeacon requests which come as FormData
 * and may have method override in query params
 */
export const beaconHandler = [
  // First, conditionally apply multer for beacon requests
  (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'POST' && req.query.method === 'PUT' && 
        req.headers['content-type']?.includes('multipart/form-data')) {
      // Use multer to parse FormData
      upload.none()(req, res, next);
    } else {
      next();
    }
  },
  // Then handle the beacon request
  (req: Request, res: Response, next: NextFunction) => {
    // Check if this is a beacon request with method override
    if (req.method === 'POST' && req.query.method === 'PUT') {
      // Override the method
      req.method = 'PUT';
      
      // Extract API credentials from query params if present
      if (req.query['x-api-key']) {
        req.headers['x-api-key'] = req.query['x-api-key'] as string;
      }
      if (req.query['x-api-secret']) {
        req.headers['x-api-secret'] = req.query['x-api-secret'] as string;
      }
      
      // Log for debugging (only in development)
      if (process.env.NODE_ENV !== 'production') {
        console.log('Beacon request processed:', {
          url: req.url,
          body: req.body,
          method: req.method
        });
      }
    }
    
    next();
  }
];