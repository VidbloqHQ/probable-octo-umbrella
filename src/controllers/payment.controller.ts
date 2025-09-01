import { Response } from "express";
import { PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
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

// Cache for token account checks
const tokenAccountCache = new Map<
  string,
  { exists: boolean; timestamp: number }
>();
const TOKEN_ACCOUNT_CACHE_TTL = 30000; // 30 seconds

/**
 * Controller for creating a transaction - OPTIMIZED
 */
export const createTransaction = async (req: TenantRequest, res: Response) => {
  const { senderPublicKey, recipients, tokenName } = req.body;
  const tenant = req.tenant;
  let success = false;

  console.log("createTransaction endpoint called");
  console.log({ senderPublicKey, recipients: recipients?.length, tokenName });

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

    // Verify sender belongs to tenant (with cache)
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

    // Process recipients
    for (const recipient of recipients) {
      const { recipientPublicKey, amount } = recipient;

      if (!recipientPublicKey || isNaN(amount) || amount <= 0) {
        return res.status(400).json({
          error:
            "Each recipient must have a valid public key and a positive amount.",
        });
      }

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
        if (solBalanceCheck.balance < amount) {
          return res.status(400).json({
            error: `Insufficient SOL balance. Required: ${amount} SOL, Available: ${solBalanceCheck.balance} SOL.`,
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

        // Check sender token account (with caching)
        const senderCacheKey = `${senderPublicKey}:${tokenName}`;
        let senderAccountExists = false;

        const cached = tokenAccountCache.get(senderCacheKey);
        if (cached && Date.now() - cached.timestamp < TOKEN_ACCOUNT_CACHE_TTL) {
          senderAccountExists = cached.exists;
        } else {
          const senderTokenAccountInfo = await connection.getAccountInfo(
            senderTokenAccount
          );
          senderAccountExists = !!senderTokenAccountInfo;
          tokenAccountCache.set(senderCacheKey, {
            exists: senderAccountExists,
            timestamp: Date.now(),
          });
        }

        if (!senderAccountExists) {
          console.log(`Creating token account for sender: ${senderPublicKey}`);
          transaction.add(
            createAssociatedTokenAccountInstruction(
              sender,
              senderTokenAccount,
              sender,
              mint
            )
          );

          return res.status(400).json({
            error: `A token account will be created for you, but you need to fund it with ${tokenName.toUpperCase()} before making transfers.`,
          });
        }

        // Check token balance
        const tokenBalance = await connection.getTokenAccountBalance(
          senderTokenAccount
        );
        const balance =
          Number(tokenBalance.value.amount) /
          Math.pow(10, tokenBalance.value.decimals);

        if (balance < amount) {
          return res.status(400).json({
            error: `Insufficient ${tokenName.toUpperCase()} balance. Required: ${amount}, Available: ${balance}.`,
          });
        }

        // Check recipient token account
        const recipientTokenAccountInfo = await connection.getAccountInfo(
          recipientTokenAccount
        );
        if (!recipientTokenAccountInfo) {
          transaction.add(
            createAssociatedTokenAccountInstruction(
              sender,
              recipientTokenAccount,
              recipientKey,
              mint
            )
          );
        }

        const decimals = tokenBalance.value.decimals;
        const transferAmount = Math.floor(amount * Math.pow(10, decimals));

        // Add transfer instruction
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

    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    console.log("Transaction created successfully");

    success = true;
    return res.status(200).json({
      transaction: serializedTransaction.toString("base64"),
      tenantId: tenant.id,
    });
  } catch (error) {
    console.error("Error creating transaction:", error);
    return res.status(500).json({ error: "Failed to create transaction" });
  } finally {
    trackQuery(success);
  }
};

/**
 * Controller for submitting a transaction - REFACTORED WITHOUT TRANSACTIONS
 */
// export const submitTransaction = async (req: TenantRequest, res: Response) => {
//   const { signedTransaction, wallet } = req.body;
//   const tenant = req.tenant;
//   let success = false;

//   try {
//     if (!tenant) {
//       return res.status(401).json({ error: "Tenant authentication required." });
//     }

//     if (!signedTransaction) {
//       return res.status(400).json({ error: "Signed transaction is required" });
//     }

//     const transactionBuffer = Buffer.from(signedTransaction, "base64");
//     const transaction = Transaction.from(transactionBuffer);

//     // Verify transaction signer
//     const signer = transaction.feePayer?.toString();
//     console.log({ signer });

//     if (!signer) {
//       return res.status(400).json({
//         error: "Invalid transaction: no fee payer",
//       });
//     }

//     // Verify user belongs to tenant
//     const user = await executeQuery(
//       () =>
//         db.user.findFirst({
//           where: {
//             walletAddress: signer,
//             tenantId: tenant.id,
//           },
//         }),
//       { maxRetries: 1, timeout: 3000 }
//     );

//     if (!user) {
//       return res.status(403).json({
//         error: "Transaction signer not authorized for this tenant",
//       });
//     }

//     // Generate idempotency key for this transaction
//     const idempotencyKey = generateIdempotencyKey(
//       "submitTransaction",
//       tenant.id,
//       signer,
//       signedTransaction.substring(0, 50) // Use first 50 chars as unique identifier
//     );

//     // Check idempotency to prevent double-spending
//     const { cached, result } = await checkIdempotencyFast(
//       idempotencyKey,
//       async () => {
//         // Submit to blockchain
//         let signature: string;
//         try {
//           signature = await connection.sendRawTransaction(
//             transaction.serialize()
//           );

//           // Wait for confirmation with timeout
//           const confirmationPromise = connection.confirmTransaction(
//             signature,
//             "confirmed"
//           );
//           const timeoutPromise = new Promise((_, reject) =>
//             setTimeout(() => reject(new Error("Confirmation timeout")), 30000)
//           );

//           await Promise.race([confirmationPromise, timeoutPromise]);
//         } catch (err: any) {
//           console.error("Transaction submission error:", err);

//           // Get detailed error information
//           let errorMessage = "Failed to submit transaction";
//           let errorLogs: string[] = [];

//           if (err instanceof Error) {
//             errorMessage = err.message;

//             // Extract Solana-specific error details
//             if ("logs" in err) {
//               errorLogs = err.logs as string[];
//             }
//           }

//           // Provide user-friendly error messages
//           if (
//             errorMessage.includes(
//               "Attempt to debit an account but found no record of a prior credit"
//             )
//           ) {
//             throw {
//               userError:
//                 "Insufficient funds. The sender account doesn't have enough tokens or SOL.",
//               logs: errorLogs,
//             };
//           }

//           if (errorMessage.includes("blockhash not found")) {
//             throw {
//               userError:
//                 "Transaction expired. Please create a new transaction and try again.",
//               logs: errorLogs,
//             };
//           }

//           if (errorMessage.includes("Confirmation timeout")) {
//             throw {
//               userError:
//                 "Transaction confirmation timeout. The transaction may still be processed.",
//               logs: errorLogs,
//             };
//           }

//           throw {
//             userError: errorMessage,
//             logs: errorLogs,
//           };
//         }

//         // Step 1: Record transaction (critical)
//         const txRecord = await executeQuery(
//           () =>
//             db.transaction.create({
//               data: {
//                 signature,
//                 createdAt: new Date(),
//                 tenantId: tenant.id,
//                 userId: user.id,
//                 transactionType: "payment",
//               },
//             }),
//           { maxRetries: 2, timeout: 5000 }
//         );

//         // Step 2: Update user points (non-critical, fire and forget)
//         executeQuery(
//           () =>
//             db.user.update({
//               where: { id: user.id },
//               data: {
//                 points: { increment: 5 },
//               },
//             }),
//           { maxRetries: 1, timeout: 3000 }
//         ).catch((err) => {
//           console.error("Failed to update user points:", err);
//           // Non-critical - continue
//         });

//         return {
//           signature: txRecord.signature,
//           points: (user.points || 0) + 5,
//         };
//       },
//       {
//         useMemoryCache: true,
//         useDbCache: true,
//         ttlMinutes: 60, // Cache for 1 hour to prevent double-spending
//       }
//     );

//     if (cached) {
//       console.log(
//         `Returned cached transaction result for idempotency key: ${idempotencyKey}`
//       );
//     }

//     success = true;
//     return res.json({
//       data: "Payment successful",
//       signature: result.signature,
//       points: result.points,
//       cached: cached,
//     });
//   } catch (error: any) {
//     console.error("Error submitting transaction:", error);

//     // Handle custom error format from idempotency function
//     if (error.userError) {
//       return res.status(400).json({
//         error: error.userError,
//         logs: error.logs || [],
//       });
//     }

//     return res.status(500).json({ error: "Failed to submit transaction" });
//   } finally {
//     trackQuery(success);
//   }
// };


export const submitTransaction = async (req: TenantRequest, res: Response) => {
  const { signedTransaction, wallet } = req.body;
  const tenant = req.tenant;
  let success = false;

  try {
    // Check if response was already sent (by timeout middleware)
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

    // Verify transaction signer
    const signer = transaction.feePayer?.toString();
    console.log({ signer });
    
    if (!signer) {
      return res.status(400).json({ 
        error: "Invalid transaction: no fee payer" 
      });
    }

    // Check response status before database query
    if (res.headersSent) {
      console.log('Response sent during validation, aborting');
      return;
    }

    // Verify user belongs to tenant
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
      // Check before sending response
      if (res.headersSent) return;
      return res.status(403).json({ 
        error: "Transaction signer not authorized for this tenant" 
      });
    }

    // Generate idempotency key for this transaction
    const idempotencyKey = generateIdempotencyKey(
      'submitTransaction',
      tenant.id,
      signer,
      signedTransaction.substring(0, 50)
    );

    // Check idempotency to prevent double-spending
    const { cached, result } = await checkIdempotencyFast(
      idempotencyKey,
      async () => {
        // Check if timed out before blockchain submission
        if (res.headersSent) {
          throw new Error('Request timed out before submission');
        }

        // Submit to blockchain with optimizations
        let signature: string;
        try {
          // Send transaction without waiting for confirmation
          signature = await connection.sendRawTransaction(
            transaction.serialize(),
            {
              skipPreflight: true,  // Skip simulation to save time
              preflightCommitment: 'confirmed',
              maxRetries: 3
            }
          );

          console.log(`Transaction submitted: ${signature}`);

          // Start confirmation in background (don't wait)
          connection.confirmTransaction(signature, "confirmed")
            .then(() => {
              console.log(`Transaction ${signature} confirmed`);
              // Since Transaction model doesn't have confirmed field, 
              // you could update transactionType or add a note
              db.transaction.updateMany({
                where: { 
                  signature,
                  tenantId: tenant.id 
                },
                data: { 
                  transactionType: 'payment_confirmed' // Update the type to indicate confirmation
                }
              }).catch(err => console.error('Failed to update confirmation status:', err));
            })
            .catch(err => {
              console.error(`Transaction ${signature} failed to confirm:`, err);
              // Optionally update to indicate failure
              db.transaction.updateMany({
                where: { 
                  signature,
                  tenantId: tenant.id 
                },
                data: { 
                  transactionType: 'payment_failed'
                }
              }).catch(err => console.error('Failed to update failure status:', err));
            });

        } catch (err: any) {
          console.error("Transaction submission error:", err);

          // Get detailed error information
          let errorMessage = "Failed to submit transaction";
          let errorLogs: string[] = [];

          if (err instanceof Error) {
            errorMessage = err.message;

            // Extract Solana-specific error details
            if ('logs' in err) {
              errorLogs = err.logs as string[];
            }
          }

          // Handle specific error cases
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

          // Generic error
          throw {
            userError: errorMessage,
            code: "TRANSACTION_FAILED",
            logs: errorLogs
          };
        }

        // Check if response was sent while submitting
        if (res.headersSent) {
          console.log('Response sent during blockchain submission');
          throw new Error('Response already sent');
        }

        // Step 1: Record transaction (critical)
        const txRecord = await executeQuery(
          () => db.transaction.create({
            data: {
              signature,
              createdAt: new Date(),
              tenantId: tenant.id,
              userId: user.id,
              transactionType: 'payment'  // Will be updated to 'payment_confirmed' by background job
            },
          }),
          { maxRetries: 2, timeout: 5000 }
        );

        // Step 2: Update user points (non-critical, fire and forget)
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
          // Non-critical - continue
        });

        return {
          signature: txRecord.signature,
          points: (user.points || 0) + 5
        };
      },
      { 
        useMemoryCache: true, 
        useDbCache: true, 
        ttlMinutes: 60 // Cache for 1 hour to prevent double-spending
      }
    );

    if (cached) {
      console.log(`Returned cached transaction result for idempotency key: ${idempotencyKey}`);
    }

    // Final check before sending response
    if (res.headersSent) {
      console.log('Response already sent, skipping final response');
      return;
    }

    success = true;
    return res.json({
      data: "Payment successful",
      signature: result.signature,
      points: result.points,
      cached: cached
    });
    
  } catch (error: any) {
    console.error("Error submitting transaction:", error);
    
    // Check if response was already sent
    if (res.headersSent) {
      console.log('Response already sent, skipping error response');
      return;
    }
    
    // Handle custom error format from idempotency function
    if (error.userError) {
      return res.status(400).json({
        error: error.userError,
        code: error.code || "TRANSACTION_ERROR",
        logs: error.logs || []
      });
    }

    // Handle generic errors
    if (error.message === 'Request timed out before submission' ||
        error.message === 'Response already sent') {
      // Don't send another response if already timed out
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

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of tokenAccountCache.entries()) {
    if (now - value.timestamp > TOKEN_ACCOUNT_CACHE_TTL) {
      tokenAccountCache.delete(key);
    }
  }
}, 60000); // Clean every minute
