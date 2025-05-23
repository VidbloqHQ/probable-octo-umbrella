// import { Response } from "express";
// import {
//   PublicKey,
//   Transaction,
//   SystemProgram,
//   LAMPORTS_PER_SOL,
// } from "@solana/web3.js";
// import {
//   TOKEN_PROGRAM_ID,
//   createTransferInstruction,
//   getAssociatedTokenAddress,
//   createAssociatedTokenAccountInstruction,
// } from "@solana/spl-token";
import { PublicKey, Transaction, SystemProgram, } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createTransferInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, } from "@solana/spl-token";
import { tokenMintAccounts, connection, checkSolBalance } from "../utils/index.js";
import { db } from "../prisma.js";
export const createTransaction = async (req, res) => {
    const { senderPublicKey, recipients, tokenName } = req.body;
    const tenant = req.tenant;
    console.log("endpoint called");
    console.log({ senderPublicKey, recipients, tokenName });
    try {
        // Tenant verification
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // Input validation
        if (!senderPublicKey ||
            !recipients ||
            !Array.isArray(recipients) ||
            !tokenName) {
            return res.status(400).json({
                error: "Missing required fields: senderPublicKey, recipients array, and tokenName",
            });
        }
        // Verify sender belongs to tenant
        const senderUser = await db.user.findFirst({
            where: {
                walletAddress: senderPublicKey,
                tenantId: tenant.id,
            },
        });
        if (!senderUser) {
            return res
                .status(403)
                .json({ error: "Sender not authorized for this tenant" });
        }
        let sender;
        try {
            sender = new PublicKey(senderPublicKey);
        }
        catch (error) {
            return res
                .status(400)
                .json({ error: "Invalid sender public key format." });
        }
        // Check SOL balance for transaction fees
        const solBalanceCheck = await checkSolBalance(connection, senderPublicKey);
        if (!solBalanceCheck.hasBalance) {
            return res.status(400).json({
                error: `Insufficient SOL balance for transaction fees. Current balance: ${solBalanceCheck.balance} SOL.`
            });
        }
        const transaction = new Transaction();
        // Process each recipient
        for (const recipient of recipients) {
            const { recipientPublicKey, amount } = recipient;
            if (!recipientPublicKey || isNaN(amount) || amount <= 0) {
                return res.status(400).json({
                    error: "Each recipient must have a valid public key and a positive amount.",
                });
            }
            let recipientKey;
            try {
                recipientKey = new PublicKey(recipientPublicKey);
            }
            catch (error) {
                return res
                    .status(400)
                    .json({ error: "Invalid recipient public key format." });
            }
            if (tokenName.toLowerCase() === "sol") {
                // For SOL transfers, check SOL balance first
                const solBalanceCheck = await checkSolBalance(connection, senderPublicKey);
                if (!solBalanceCheck.hasBalance || solBalanceCheck.balance < amount) {
                    return res.status(400).json({
                        error: `Insufficient SOL balance. Required: ${amount} SOL, Available: ${solBalanceCheck.balance} SOL.`
                    });
                }
                transaction.add(SystemProgram.transfer({
                    fromPubkey: sender,
                    toPubkey: recipientKey,
                    lamports: amount * 1e9,
                }));
            }
            else {
                const mintAddress = tokenMintAccounts[tokenName.toLowerCase()];
                if (!mintAddress) {
                    return res.status(400).json({ error: "Token not supported." });
                }
                const mint = new PublicKey(mintAddress);
                // Get sender token account address
                const senderTokenAccount = await getAssociatedTokenAddress(mint, sender);
                // Check if sender token account exists
                const senderTokenAccountInfo = await connection.getAccountInfo(senderTokenAccount);
                // If sender token account doesn't exist, add instruction to create it
                if (!senderTokenAccountInfo) {
                    console.log(`Creating token account for sender: ${senderPublicKey}`);
                    transaction.add(createAssociatedTokenAccountInstruction(sender, // Payer
                    senderTokenAccount, // Associated token account address
                    sender, // Owner
                    mint // Token mint address
                    ));
                    // Since we're creating a new token account, there's no balance yet
                    // We should return an error about insufficient balance
                    return res.status(400).json({
                        error: `A token account will be created for you, but you need to fund it with ${tokenName.toUpperCase()} before making transfers.`
                    });
                }
                else {
                    // Check token balance
                    const tokenBalance = await connection.getTokenAccountBalance(senderTokenAccount);
                    const balance = Number(tokenBalance.value.amount) / Math.pow(10, tokenBalance.value.decimals);
                    if (balance < amount) {
                        return res.status(400).json({
                            error: `Insufficient ${tokenName.toUpperCase()} balance. Required: ${amount}, Available: ${balance}.`
                        });
                    }
                }
                // Get recipient token account address
                const recipientTokenAccount = await getAssociatedTokenAddress(mint, recipientKey);
                // Check if recipient token account exists
                const recipientTokenAccountInfo = await connection.getAccountInfo(recipientTokenAccount);
                // If recipient token account doesn't exist, add instruction to create it
                if (!recipientTokenAccountInfo) {
                    transaction.add(createAssociatedTokenAccountInstruction(sender, // Payer
                    recipientTokenAccount, // Associated token account address
                    recipientKey, // Owner
                    mint // Token mint address
                    ));
                }
                // Add transfer instruction
                transaction.add(createTransferInstruction(senderTokenAccount, recipientTokenAccount, sender, amount, [], TOKEN_PROGRAM_ID));
            }
        }
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = sender;
        const serializedTransaction = transaction.serialize({
            requireAllSignatures: false,
            verifySignatures: false,
        });
        console.log({ serializedTransaction });
        res.status(200).json({
            transaction: serializedTransaction.toString("base64"),
            tenantId: tenant.id, // Include tenant ID in response
        });
    }
    catch (error) {
        console.error("Error creating transaction:", error);
        res.status(500).json({ error: "Failed to create transaction" });
    }
};
export const submitTransaction = async (req, res) => {
    const { signedTransaction, wallet } = req.body;
    const tenant = req.tenant;
    try {
        // Tenant verification
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        const transactionBuffer = Buffer.from(signedTransaction, "base64");
        const transaction = Transaction.from(transactionBuffer);
        // Verify transaction signer belongs to tenant
        const signer = transaction.feePayer?.toString();
        console.log({ signer });
        if (!signer) {
            return res
                .status(400)
                .json({ error: "Invalid transaction: no fee payer" });
        }
        const user = await db.user.findFirst({
            where: {
                walletAddress: signer,
                tenantId: tenant.id,
            },
        });
        if (!user) {
            return res
                .status(403)
                .json({ error: "Transaction signer not authorized for this tenant" });
        }
        // Submit to blockchain with better error handling
        try {
            const signature = await connection.sendRawTransaction(transaction.serialize());
            // Wait for confirmation with a timeout
            const confirmation = await Promise.race([
                connection.confirmTransaction(signature, "confirmed"),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Confirmation timeout")), 30000))
            ]);
            // Update user points (tenant-scoped)
            const updatedUser = await db.user.update({
                where: {
                    id: user.id,
                },
                data: {
                    points: (user.points || 0) + 5,
                },
            });
            // Record transaction with tenant relationship
            const txRecord = await db.transaction.create({
                data: {
                    signature,
                    createdAt: new Date(),
                    tenantId: tenant.id,
                    userId: user.id,
                },
            });
            res.json({
                data: "Payment successful",
                signature: txRecord.signature,
                points: updatedUser.points,
            });
        }
        catch (err) {
            console.error("Transaction submission error:", err);
            // Get detailed error information when available
            let errorMessage = "Failed to submit transaction";
            let errorLogs = [];
            if (err instanceof Error) {
                errorMessage = err.message;
                // Try to extract Solana-specific error details
                // @ts-ignore - SendTransactionError is a specific Solana error type
                if (err.logs) {
                    // @ts-ignore
                    errorLogs = err.logs;
                }
            }
            // Check for specific Solana errors and provide user-friendly messages
            if (errorMessage.includes("Attempt to debit an account but found no record of a prior credit")) {
                return res.status(400).json({
                    error: "Insufficient funds. The sender account doesn't have enough tokens or SOL.",
                    logs: errorLogs
                });
            }
            if (errorMessage.includes("blockhash not found")) {
                return res.status(400).json({
                    error: "Transaction expired. Please create a new transaction and try again.",
                    logs: errorLogs
                });
            }
            return res.status(400).json({
                error: errorMessage,
                logs: errorLogs
            });
        }
    }
    catch (error) {
        console.error("Error submitting transaction:", error);
        res.status(500).json({ error: "Failed to submit transaction" });
    }
    finally {
        await db.$disconnect();
    }
};
