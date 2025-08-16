// utils/controller-wrapper.ts
import { Request, Response, NextFunction } from "express";

/**
 * Wraps async controller functions to handle errors and prevent double responses
 */
export function wrapController(controller: Function) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Add a flag to track if this specific controller execution has sent a response
      const responseTracker = {
        sent: false,
        sendResponse: (fn: Function) => {
          if (responseTracker.sent) {
            console.error(`[ControllerWrapper] Attempted to send response twice in ${req.method} ${req.path}`);
            return res;
          }
          responseTracker.sent = true;
          return fn();
        }
      };
      
      // Attach to request for controller to use
      (req as any).responseTracker = responseTracker;
      
      // Execute the controller
      await controller(req, res, next);
      
      // Check if a response was sent
      if (!res.headersSent && !responseTracker.sent) {
        // Log this as it might indicate a controller that forgot to send a response
        console.warn(`[ControllerWrapper] Controller didn't send response: ${req.method} ${req.path}`);
      }
    } catch (error: any) {
      // Only send error response if no response has been sent yet
      if (!res.headersSent) {
        console.error(`[ControllerWrapper] Error in ${req.method} ${req.path}:`, error);
        
        // Handle specific error types
        if (error.code === 'TIMEOUT' || error.message === 'Query timeout') {
          res.status(504).json({
            error: 'Request timeout',
            message: 'The operation took too long. Please try again.',
            requestId: (req as any).id
          });
        } else if (error.code === 'P2024') {
          res.status(503).json({
            error: 'Service temporarily unavailable',
            message: 'Database connection pool exhausted. Please try again.',
            requestId: (req as any).id
          });
        } else {
          res.status(500).json({
            error: 'Internal server error',
            message: process.env.NODE_ENV === 'development' ? error.message : 'An error occurred',
            requestId: (req as any).id
          });
        }
      } else {
        // Response was already sent, just log the error
        console.error(`[ControllerWrapper] Error after response sent in ${req.method} ${req.path}:`, error);
      }
    }
  };
}

/**
 * Simple wrapper that just catches errors without sending responses
 */
export function wrapControllerSimple(controller: Function) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await controller(req, res, next);
    } catch (error) {
      // If headers haven't been sent, pass to error handler
      if (!res.headersSent) {
        next(error);
      } else {
        // Just log it
        console.error(`[Controller] Error after response: ${req.method} ${req.path}`, error);
      }
    }
  };
}