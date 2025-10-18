import { Response } from "express";
import { PublicKey, Transaction, SystemProgram, Connection } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createTransferInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

import {
  tokenMintAccounts,
  connection,
  checkSolBalance,
  checkIdempotencyFast,
  generateIdempotencyKey,
} from "../utils/index.js";
import { db, executeQuery, trackQuery } from "../prisma.js";
import { TenantRequest } from "../types/index.js";
import { getSanctumGateway } from "../utils/sanctum.js";

// Cache for token account checks
const tokenAccountCache = new Map<
  string,
  { exists: boolean; timestamp: number }
>();

const TOKEN_ACCOUNT_CACHE_TTL = 30000; // 30 seconds

/**
 * Helper function to get account info with retry logic
 */
async function getAccountInfoWithRetry(
  connection: Connection,
  account: PublicKey,
  maxRetries = 3
) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const info = await connection.getAccountInfo(account);
      if (info !== null) return info;
      
      if (i < maxRetries - 1) {
        console.log(`Account info attempt ${i + 1} returned null, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (err) {
      console.error(`Attempt ${i + 1} failed:`, err);
      if (i === maxRetries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return null;
}

/**
 * Controller for creating a transaction - ENHANCED WITH SANCTUM OPTIMIZATION
 */
export const createTransaction = async (req: TenantRequest, res: Response) => {
  const { 
    senderPublicKey, 
    recipients, 
    tokenName,
    narration,
    streamId,
    deliveryMethod = 'standard' // NEW: Accept delivery method preference
  } = req.body;
  const tenant = req.tenant;
  let success = false;

  const forceRefresh = req.query?.forceRefresh === 'true';

  try {
    // Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    // Input validation
    if (
      !senderPublicKey ||
      !recipients ||
      !Array.isArray(recipients) ||
      !tokenName
    ) {
      return res.status(400).json({
        error:
          "Missing required fields: senderPublicKey, recipients array, and tokenName",
      });
    }

    // If streamId provided, verify it exists and belongs to tenant
    if (streamId) {
      const stream = await executeQuery(
        () =>
          db.stream.findFirst({
            where: {
              id: streamId,
              tenantId: tenant.id,
            },
            select: { id: true },
          }),
        { maxRetries: 1, timeout: 3000 }
      );

      if (!stream) {
        return res.status(400).json({
          error: "Invalid stream ID or stream not found for this tenant",
        });
      }
    }

    // Verify sender belongs to tenant
    const senderUser = await executeQuery(
      () =>
        db.user.findFirst({
          where: {
            walletAddress: senderPublicKey,
            tenantId: tenant.id,
          },
          select: { id: true },
        }),
      { maxRetries: 1, timeout: 5000 }
    );

    if (!senderUser) {
      return res.status(403).json({
        error: "Sender not authorized for this tenant",
      });
    }

    let sender: PublicKey;
    try {
      sender = new PublicKey(senderPublicKey);
    } catch (error) {
      return res.status(400).json({
        error: "Invalid sender public key format.",
      });
    }

    // Check SOL balance for transaction fees
    const solBalanceCheck = await checkSolBalance(connection, senderPublicKey);
    if (!solBalanceCheck.hasBalance) {
      return res.status(400).json({
        error: `Insufficient SOL balance for transaction fees. Current balance: ${solBalanceCheck.balance} SOL.`,
      });
    }

    const transaction = new Transaction();
    const isSOLTransfer = tokenName.toLowerCase() === "sol";
    
    // Calculate total amount being sent
    let totalAmount = 0;

    // Process recipients
    for (const recipient of recipients) {
      const { recipientPublicKey, amount } = recipient;

      if (!recipientPublicKey || isNaN(amount) || amount <= 0) {
        return res.status(400).json({
          error:
            "Each recipient must have a valid public key and a positive amount.",
        });
      }

      totalAmount += amount;

      let recipientKey: PublicKey;
      try {
        recipientKey = new PublicKey(recipientPublicKey);
      } catch (error) {
        return res.status(400).json({
          error: `Invalid recipient public key format: ${recipientPublicKey}`,
        });
      }

      if (isSOLTransfer) {
        // For SOL transfers
        if (solBalanceCheck.balance < totalAmount) {
          return res.status(400).json({
            error: `Insufficient SOL balance. Required: ${totalAmount} SOL, Available: ${solBalanceCheck.balance} SOL.`,
          });
        }

        transaction.add(
          SystemProgram.transfer({
            fromPubkey: sender,
            toPubkey: recipientKey,
            lamports: amount * 1e9,
          })
        );
      } else {
        // For token transfers
        const mintAddress = tokenMintAccounts[tokenName.toLowerCase()];
        if (!mintAddress) {
          return res.status(400).json({
            error: `Token ${tokenName} not supported.`,
          });
        }

        const mint = new PublicKey(mintAddress);

        // Get token accounts
        const senderTokenAccount = await getAssociatedTokenAddress(
          mint,
          sender
        );
        const recipientTokenAccount = await getAssociatedTokenAddress(
          mint,
          recipientKey
        );

        // Check sender token account
        const senderCacheKey = `${senderPublicKey}:${tokenName}`;
        let senderAccountExists = false;
        let needToCreateSenderAccount = false;

        const cached = tokenAccountCache.get(senderCacheKey);
        if (!forceRefresh && cached && Date.now() - cached.timestamp < TOKEN_ACCOUNT_CACHE_TTL) {
          senderAccountExists = cached.exists;
          console.log('Using cached sender account status:', senderAccountExists);
        } else {
          const senderTokenAccountInfo = await getAccountInfoWithRetry(
            connection,
            senderTokenAccount,
            3
          );
          senderAccountExists = !!senderTokenAccountInfo;
          
          console.log('Fresh sender account check:', {
            exists: senderAccountExists,
            accountInfo: senderTokenAccountInfo ? 'Found' : 'Not found'
          });
          
          tokenAccountCache.set(senderCacheKey, {
            exists: senderAccountExists,
            timestamp: Date.now(),
          });
        }

        // Handle sender token account
        if (!senderAccountExists) {
          console.log(`Sender token account doesn't exist for: ${senderPublicKey}`);
          
          transaction.add(
            createAssociatedTokenAccountInstruction(
              sender,
              senderTokenAccount,
              sender,
              mint
            )
          );
          
          needToCreateSenderAccount = true;
          console.log('Added instruction to create sender token account');
        } else {
          // Account exists, check the actual balance
          try {
            const tokenBalance = await connection.getTokenAccountBalance(
              senderTokenAccount
            );
            const balance =
              Number(tokenBalance.value.amount) /
              Math.pow(10, tokenBalance.value.decimals);

            console.log(`Token balance check: ${balance} ${tokenName.toUpperCase()}`);

            if (balance < totalAmount) {
              return res.status(400).json({
                error: `Insufficient ${tokenName.toUpperCase()} balance. Required: ${totalAmount}, Available: ${balance}.`,
              });
            }
          } catch (balanceError) {
            console.error('Error checking token balance:', balanceError);
          }
        }

        // Check recipient token account
        const recipientTokenAccountInfo = await getAccountInfoWithRetry(
          connection,
          recipientTokenAccount,
          2
        );
        
        if (!recipientTokenAccountInfo) {
          console.log('Recipient token account does not exist, adding creation instruction');
          transaction.add(
            createAssociatedTokenAccountInstruction(
              sender,
              recipientTokenAccount,
              recipientKey,
              mint
            )
          );
        }

        if (needToCreateSenderAccount) {
          console.log('Sender account needs creation - transaction will create it');
          
          return res.status(400).json({
            error: `Your USDC token account needs to be initialized. Please try again - the account will be created automatically if you have SOL for fees.`,
            needsAccountCreation: true,
            estimatedFee: "~0.002 SOL"
          });
        }

        // Add the transfer instruction
        const tokenBalance = await connection.getTokenAccountBalance(
          senderTokenAccount
        );
        const decimals = tokenBalance.value.decimals;
        const transferAmount = Math.floor(amount * Math.pow(10, decimals));

        transaction.add(
          createTransferInstruction(
            senderTokenAccount,
            recipientTokenAccount,
            sender,
            transferAmount,
            [],
            TOKEN_PROGRAM_ID
          )
        );
      }
    }

    // Set transaction parameters
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = sender;

    let serializedTransaction: Buffer;
    let optimizedBySanctum = false;
    
    // NEW: If priority delivery, optimize through Sanctum first
    if (deliveryMethod === 'priority' && process.env.SANCTUM_API_KEY) {
      try {
        console.log('🔧 Optimizing transaction via Sanctum Gateway...');
        const sanctum = getSanctumGateway(connection);
        const optimizedBase64 = await sanctum.buildGatewayTransaction(transaction);
        serializedTransaction = Buffer.from(optimizedBase64, 'base64');
        optimizedBySanctum = true;
        console.log('✅ Transaction optimized with Sanctum tips and priority fees');
      } catch (sanctumError) {
        console.error('❌ Sanctum optimization failed, using standard transaction:', sanctumError);
        // Fallback to non-optimized transaction
        serializedTransaction = transaction.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        });
      }
    } else {
      // Standard delivery - no optimization needed
      serializedTransaction = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
    }

    console.log("Transaction created successfully");

    success = true;
    return res.status(200).json({
      transaction: serializedTransaction.toString("base64"),
      tenantId: tenant.id,
      metadata: {
        totalAmount: totalAmount.toString(),
        tokenName,
        narration,
        streamId,
        recipientsCount: recipients.length,
        recipients: recipients.map(r => ({
          address: r.recipientPublicKey,
          amount: r.amount.toString()
        })),
        deliveryMethod: deliveryMethod || 'standard',
        optimizedBySanctum
      }
    });
  } catch (error) {
    console.error("Error creating transaction:", error);
    return res.status(500).json({ error: "Failed to create transaction" });
  } finally {
    trackQuery(success);
  }
};

/**
 * Controller for submitting a transaction - ENHANCED WITH PRIORITY DELIVERY
 */
export const submitTransaction = async (req: TenantRequest, res: Response) => {
  const { 
    signedTransaction, 
    wallet,
    amount,
    tokenName,
    narration,
    streamId,
    recipients,
    deliveryMethod = 'standard' // NEW: 'standard' or 'priority'
  } = req.body;
  const tenant = req.tenant;
  let success = false;

  try {
    if (res.headersSent) {
      console.log('Response already sent (likely timeout), aborting submitTransaction');
      return;
    }

    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!signedTransaction) {
      return res.status(400).json({ error: "Signed transaction is required" });
    }

    const transactionBuffer = Buffer.from(signedTransaction, "base64");
    const transaction = Transaction.from(transactionBuffer);

    const signer = transaction.feePayer?.toString();
    console.log({ signer, amount, tokenName, narration, streamId, deliveryMethod });
    
    if (!signer) {
      return res.status(400).json({ 
        error: "Invalid transaction: no fee payer" 
      });
    }

    if (res.headersSent) {
      console.log('Response sent during validation, aborting');
      return;
    }

    const user = await executeQuery(
      () => db.user.findFirst({
        where: {
          walletAddress: signer,
          tenantId: tenant.id,
        },
      }),
      { maxRetries: 1, timeout: 3000 }
    );

    if (!user) {
      if (res.headersSent) return;
      return res.status(403).json({ 
        error: "Transaction signer not authorized for this tenant" 
      });
    }

    if (streamId) {
      const streamExists = await executeQuery(
        () => db.stream.findFirst({
          where: {
            id: streamId,
            tenantId: tenant.id,
          },
          select: { id: true }
        }),
        { maxRetries: 1, timeout: 3000 }
      );

      if (!streamExists) {
        if (res.headersSent) return;
        return res.status(400).json({
          error: "Invalid stream ID or stream not found"
        });
      }
    }

    const idempotencyKey = generateIdempotencyKey(
      'submitTransaction',
      tenant.id,
      signer,
      signedTransaction.substring(0, 50)
    );

    const { cached, result } = await checkIdempotencyFast(
      idempotencyKey,
      async () => {
        if (res.headersSent) {
          throw new Error('Request timed out before submission');
        }

        let signature: string;
        let actualDeliveryMethod: 'standard' | 'priority' = 'standard';

        try {
          // Check if priority delivery should be used
          const usePriorityDelivery = deliveryMethod === 'priority' && process.env.SANCTUM_API_KEY;

          if (usePriorityDelivery) {
            try {
              console.log('📤 Using priority delivery (multi-path)...');
              const sanctum = getSanctumGateway(connection);
              signature = await sanctum.submitTransaction(transaction);
              actualDeliveryMethod = 'priority';
              console.log(`✅ Priority delivery successful: ${signature}`);
            } catch (priorityError) {
              console.error('❌ Priority delivery failed, using standard delivery:', priorityError);
              
              // Fallback to standard delivery
              signature = await connection.sendRawTransaction(
                transaction.serialize(),
                {
                  skipPreflight: false,
                  preflightCommitment: 'confirmed',
                  maxRetries: 3
                }
              );
              actualDeliveryMethod = 'standard';
              console.log(`✅ Standard delivery successful (fallback): ${signature}`);
            }
          } else {
            // Use standard delivery
            console.log('📤 Using standard delivery...');
            signature = await connection.sendRawTransaction(
              transaction.serialize(),
              {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
                maxRetries: 3
              }
            );
            actualDeliveryMethod = 'standard';
            console.log(`✅ Standard delivery successful: ${signature}`);
          }

          // Start confirmation in background (don't wait)
          connection.confirmTransaction(signature, "confirmed")
            .then(async (result) => {
              const status = result.value.err ? 'failed' : 'confirmed';
              console.log(`Transaction ${signature} ${status} (delivery: ${actualDeliveryMethod})`);
              try {
                await db.transaction.updateMany({
                  where: { 
                    signature,
                    tenantId: tenant.id 
                  },
                  data: { 
                    status
                  }
                });
              } catch (err) {
                console.error('Failed to update confirmation status:', err);
              }
            })
            .catch(async (err) => {
              console.error(`Transaction ${signature} failed to confirm:`, err);
              try {
                await db.transaction.updateMany({
                  where: { 
                    signature,
                    tenantId: tenant.id 
                  },
                  data: { 
                    status: 'failed'
                  }
                });
              } catch (updateErr) {
                console.error('Failed to update failure status:', updateErr);
              }
            });

        } catch (err: any) {
          console.error("Transaction submission error:", err);

          let errorMessage = "Failed to submit transaction";
          let errorLogs: string[] = [];

          if (err instanceof Error) {
            errorMessage = err.message;

            if ('logs' in err) {
              errorLogs = err.logs as string[];
            }
          }

          if (errorMessage.includes("Blockhash not found") || 
              errorMessage.includes("blockhash")) {
            throw {
              userError: "Transaction expired. The transaction was created too long ago and is no longer valid. Please create and submit a new transaction immediately.",
              code: "BLOCKHASH_EXPIRED",
              logs: errorLogs
            };
          }

          if (errorMessage.includes("Attempt to debit an account but found no record of a prior credit")) {
            throw {
              userError: "Insufficient funds. The sender account doesn't have enough tokens or SOL.",
              code: "INSUFFICIENT_FUNDS",
              logs: errorLogs
            };
          }

          if (errorMessage.includes("already been processed")) {
            throw {
              userError: "This transaction has already been processed.",
              code: "DUPLICATE_TRANSACTION",
              logs: errorLogs
            };
          }

          throw {
            userError: errorMessage,
            code: "TRANSACTION_FAILED",
            logs: errorLogs
          };
        }

        if (res.headersSent) {
          console.log('Response sent during blockchain submission');
          throw new Error('Response already sent');
        }

        let recipientAddress: string | null = null;
        if (recipients && recipients.length === 1) {
          recipientAddress = recipients[0].address || recipients[0].recipientPublicKey;
        }

        const txRecord = await executeQuery(
          () => db.transaction.create({
            data: {
              signature,
              createdAt: new Date(),
              tenantId: tenant.id,
              userId: user.id,
              transactionType: 'payment',
              status: 'pending',
              amount: amount?.toString() || null,
              tokenName: tokenName || 'SOL',
              narration: narration || null,
              streamId: streamId || null,
              senderAddress: signer,
              recipientAddress,
              recipients: recipients ? recipients : null,
            },
          }),
          { maxRetries: 2, timeout: 5000 }
        );

        executeQuery(
          () => db.user.update({
            where: { id: user.id },
            data: {
              points: { increment: 5 }
            },
          }),
          { maxRetries: 1, timeout: 3000 }
        ).catch(err => {
          console.error("Failed to update user points:", err);
        });

        return {
          signature: txRecord.signature,
          points: (user.points || 0) + 5,
          transactionId: txRecord.id,
          status: 'pending',
          deliveryMethod: actualDeliveryMethod
        };
      },
      { 
        useMemoryCache: true, 
        useDbCache: true, 
        ttlMinutes: 60
      }
    );

    if (cached) {
      console.log(`Returned cached transaction result for idempotency key: ${idempotencyKey}`);
    }

    if (res.headersSent) {
      console.log('Response already sent, skipping final response');
      return;
    }

    success = true;
    return res.json({
      data: "Payment submitted",
      signature: result.signature,
      transactionId: result.transactionId,
      status: result.status || 'pending',
      points: result.points,
      cached: cached,
      deliveryMethod: result.deliveryMethod || 'standard'
    });
    
  } catch (error: any) {
    console.error("Error submitting transaction:", error);
    
    if (res.headersSent) {
      console.log('Response already sent, skipping error response');
      return;
    }
    
    if (error.userError) {
      return res.status(400).json({
        error: error.userError,
        code: error.code || "TRANSACTION_ERROR",
        logs: error.logs || []
      });
    }

    if (error.message === 'Request timed out before submission' ||
        error.message === 'Response already sent') {
      return;
    }

    return res.status(500).json({ 
      error: "Failed to submit transaction",
      code: "INTERNAL_ERROR"
    });
  } finally {
    trackQuery(success);
  }
};

// Cleanup cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of tokenAccountCache.entries()) {
    if (now - value.timestamp > TOKEN_ACCOUNT_CACHE_TTL) {
      tokenAccountCache.delete(key);
    }
  }
}, 60000);
// ```

// ---

// That's the complete controller file! The key changes are:

// 1. ✅ Import `getSanctumGateway` from sanctum.js
// 2. ✅ Accept `deliveryMethod` parameter in createTransaction
// 3. ✅ Call `sanctum.buildGatewayTransaction()` when priority delivery is requested
// 4. ✅ Return optimized transaction to frontend for signing
// 5. ✅ Submit via Sanctum in submitTransaction controller

// Now test it and you should see:
// ```
// 🔧 Optimizing transaction via Sanctum Gateway...
// ✅ Transaction optimized with Sanctum tips and priority fees
// 📤 Using priority delivery (multi-path)...
// ✅ Priority delivery successful: [signature]