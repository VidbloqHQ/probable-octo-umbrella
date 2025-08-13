// src/utils/transaction-free.utils.ts

import { db, executeQuery } from "../prisma.js";
import { Prisma } from "@prisma/client";

/**
 * Compensation pattern utilities for transaction-free operations
 */

export interface CompensationAction {
  name: string;
  execute: () => Promise<void>;
  compensate: () => Promise<void>;
}

/**
 * Execute operations with compensation on failure
 */
export async function executeWithCompensation(
  actions: CompensationAction[]
): Promise<{ success: boolean; errors: string[]; completed: string[] }> {
  const completed: string[] = [];
  const errors: string[] = [];
  let failedIndex = -1;

  // Execute actions in sequence
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    try {
      await action.execute();
      completed.push(action.name);
      console.log(`[Compensation] Executed: ${action.name}`);
    } catch (error: any) {
      failedIndex = i;
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(`${action.name}: ${errorMessage}`);
      console.error(`[Compensation] Action ${action.name} failed:`, error);
      break;
    }
  }

  // If an action failed, compensate for completed actions
  if (failedIndex >= 0) {
    console.log(`[Compensation] Compensating for ${failedIndex} completed actions`);
    
    // Compensate in reverse order
    for (let i = failedIndex - 1; i >= 0; i--) {
      const action = actions[i];
      try {
        await action.compensate();
        console.log(`[Compensation] Compensated: ${action.name}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[Compensation] Failed to compensate ${action.name}:`, error);
        errors.push(`Compensation failed for ${action.name}: ${errorMessage}`);
      }
    }
  }

  return {
    success: failedIndex === -1,
    errors,
    completed
  };
}

/**
 * Distributed lock using database (poor man's lock)
 */
export class DistributedLock {
  
  async acquire(
    key: string,
    ttlSeconds: number = 30
  ): Promise<boolean> {
    const lockKey = `lock:${key}`;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    
    try {
      await executeQuery(
        () => db.idempotencyKey.create({
          data: {
            key: lockKey,
            response: { locked: true, acquiredAt: new Date() },
            expiresAt
          }
        }),
        { maxRetries: 1, timeout: 1000 }
      );
      console.log(`[Lock] Acquired lock: ${lockKey}`);
      return true;
    } catch (error: any) {
      if (error.code === 'P2002') {
        // Lock already exists - check if expired
        const existing = await executeQuery(
          () => db.idempotencyKey.findUnique({
            where: { key: lockKey },
            select: { expiresAt: true }
          }),
          { maxRetries: 1, timeout: 1000 }
        );
        
        if (existing && existing.expiresAt < new Date()) {
          // Lock expired, try to delete and reacquire
          console.log(`[Lock] Lock expired, attempting to reacquire: ${lockKey}`);
          try {
            await executeQuery(
              () => db.idempotencyKey.delete({
                where: { key: lockKey }
              }),
              { maxRetries: 1, timeout: 1000 }
            );
            
            // Try to acquire again (recursive call with limit)
            if (ttlSeconds > 0) {
              return this.acquire(key, ttlSeconds);
            }
          } catch {
            return false;
          }
        }
      }
      return false;
    }
  }
  
  async release(key: string): Promise<void> {
    const lockKey = `lock:${key}`;
    
    try {
      await executeQuery(
        () => db.idempotencyKey.delete({
          where: { key: lockKey }
        }),
        { maxRetries: 1, timeout: 1000 }
      );
      console.log(`[Lock] Released lock: ${lockKey}`);
    } catch (error) {
      // Ignore errors - lock might have expired
      console.log(`[Lock] Failed to release lock (might be expired): ${lockKey}`);
    }
  }
  
  async withLock<T>(
    key: string,
    operation: () => Promise<T>,
    options: { ttlSeconds?: number; maxRetries?: number } = {}
  ): Promise<T> {
    const { ttlSeconds = 30, maxRetries = 3 } = options;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const acquired = await this.acquire(key, ttlSeconds);
      
      if (acquired) {
        try {
          const result = await operation();
          return result;
        } finally {
          await this.release(key);
        }
      }
      
      // Wait before retry with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
      console.log(`[Lock] Failed to acquire lock, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    throw new Error(`Failed to acquire lock for ${key} after ${maxRetries} attempts`);
  }
}

/**
 * Optimistic concurrency control using version field
 * Note: The model must have a 'version' field of type Int
 */
export async function updateWithOptimisticLock<T>(
  model: any,
  where: any,
  data: any,
  maxRetries: number = 3
): Promise<T | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Get current record with version
      const current: any = await executeQuery(
        () => model.findUnique({
          where,
          select: { version: true, id: true }
        }),
        { maxRetries: 1, timeout: 2000 }
      );
      
      if (!current) {
        console.log(`[OptimisticLock] Record not found`);
        return null;
      }
      
      // Update with version check
      const currentVersion = (current.version as number) || 0;
      const result: { count: number } = await executeQuery(
        () => model.updateMany({
          where: {
            ...where,
            version: currentVersion
          },
          data: {
            ...data,
            version: currentVersion + 1
          }
        }),
        { maxRetries: 1, timeout: 3000 }
      );
      
      if (result.count > 0) {
        // Fetch and return the updated record
        const updated = await executeQuery(
          () => model.findUnique({ where }),
          { maxRetries: 1, timeout: 2000 }
        );
        console.log(`[OptimisticLock] Successfully updated with version ${currentVersion + 1}`);
        return updated as T;
      }
      
      // Version mismatch - retry
      console.log(`[OptimisticLock] Version mismatch, retrying (attempt ${attempt + 1}/${maxRetries})`);
      
    } catch (error) {
      console.error(`[OptimisticLock] Update failed:`, error);
      if (attempt === maxRetries - 1) {
        throw error;
      }
    }
    
    // Wait before retry with exponential backoff
    await new Promise(resolve => 
      setTimeout(resolve, 100 * Math.pow(2, attempt))
    );
  }
  
  return null;
}

/**
 * Batch operation manager for non-transactional bulk operations
 */
export class BatchOperationManager {
  async executeBatch<T>(
    operations: Array<() => Promise<T>>,
    options: {
      batchSize?: number;
      delayBetweenBatches?: number;
      continueOnError?: boolean;
    } = {}
  ): Promise<{
    successful: T[];
    failed: Array<{ index: number; error: any }>;
  }> {
    const {
      batchSize = 10,
      delayBetweenBatches = 100,
      continueOnError = true
    } = options;
    
    const successful: T[] = [];
    const failed: Array<{ index: number; error: any }> = [];
    
    console.log(`[Batch] Starting batch execution of ${operations.length} operations`);
    
    for (let i = 0; i < operations.length; i += batchSize) {
      const batch = operations.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;
      
      console.log(`[Batch] Processing batch ${batchNumber} (${batch.length} operations)`);
      
      const results = await Promise.allSettled(
        batch.map(op => op())
      );
      
      results.forEach((result, batchIndex) => {
        const globalIndex = i + batchIndex;
        
        if (result.status === 'fulfilled') {
          successful.push(result.value);
        } else {
          failed.push({
            index: globalIndex,
            error: result.reason
          });
          
          if (!continueOnError) {
            throw new Error(`Batch operation failed at index ${globalIndex}: ${result.reason}`);
          }
        }
      });
      
      // Delay between batches to avoid overwhelming the database
      if (i + batchSize < operations.length && delayBetweenBatches > 0) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }
    
    console.log(`[Batch] Completed: ${successful.length} successful, ${failed.length} failed`);
    return { successful, failed };
  }
}

/**
 * Saga pattern for complex multi-step operations
 */
export interface SagaStep<T = any> {
  name: string;
  execute: (context: T) => Promise<void>;
  compensate: (context: T) => Promise<void>;
  canRetry?: boolean;
  maxRetries?: number;
}

export class Saga<T = any> {
  private steps: SagaStep<T>[] = [];
  private completedSteps: string[] = [];
  
  addStep(step: SagaStep<T>): Saga<T> {
    this.steps.push(step);
    return this;
  }
  
  async execute(context: T): Promise<{
    success: boolean;
    completedSteps: string[];
    failedStep?: string;
    error?: any;
  }> {
    this.completedSteps = [];
    console.log(`[Saga] Starting saga with ${this.steps.length} steps`);
    
    for (const step of this.steps) {
      const maxRetries = step.maxRetries || 1;
      let lastError: any;
      
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          console.log(`[Saga] Executing step: ${step.name} (attempt ${attempt + 1}/${maxRetries})`);
          await step.execute(context);
          this.completedSteps.push(step.name);
          console.log(`[Saga] Step completed: ${step.name}`);
          break;
        } catch (error) {
          lastError = error;
          console.error(`[Saga] Step ${step.name} failed (attempt ${attempt + 1}):`, error);
          
          if (!step.canRetry || attempt === maxRetries - 1) {
            // Step failed - start compensation
            console.log(`[Saga] Starting compensation due to failure in step: ${step.name}`);
            await this.compensate(context);
            
            return {
              success: false,
              completedSteps: this.completedSteps,
              failedStep: step.name,
              error: lastError
            };
          }
          
          // Wait before retry
          const delay = 1000 * Math.pow(2, attempt);
          console.log(`[Saga] Retrying step ${step.name} in ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    console.log(`[Saga] All steps completed successfully`);
    return {
      success: true,
      completedSteps: this.completedSteps
    };
  }
  
  private async compensate(context: T): Promise<void> {
    console.log(`[Saga] Compensating ${this.completedSteps.length} steps`);
    
    // Compensate in reverse order
    const stepsToCompensate = this.steps
      .filter(step => this.completedSteps.includes(step.name))
      .reverse();
    
    for (const step of stepsToCompensate) {
      try {
        console.log(`[Saga] Compensating step: ${step.name}`);
        await step.compensate(context);
        console.log(`[Saga] Compensated: ${step.name}`);
      } catch (error) {
        console.error(`[Saga] Failed to compensate ${step.name}:`, error);
        // Continue with other compensations
      }
    }
    
    console.log(`[Saga] Compensation completed`);
  }
}

// Export singleton instance of DistributedLock for convenience
export const distributedLock = new DistributedLock();

// Export default for easier imports
export default {
  executeWithCompensation,
  DistributedLock,
  distributedLock,
  updateWithOptimisticLock,
  BatchOperationManager,
  Saga
};