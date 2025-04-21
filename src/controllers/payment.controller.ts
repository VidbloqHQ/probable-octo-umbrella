import { Response } from "express";
import {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createTransferInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

import { tokenMintAccounts, connection } from "../utils/index.js";
import { db } from "../prisma.js";
import { TenantRequest } from "../types/index.js";

export const createTransaction = async (req: TenantRequest, res: Response) => {
  const { senderPublicKey, recipients, tokenName } = req.body;
  const tenant = req.tenant;
  const companyPublicKey = "4jhQjEw1CtMkyE9PXNVMBmUNEBekpiF4XudwDjWFZsnc";
  const feeInLamports = 0.06 * LAMPORTS_PER_SOL;

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
    } catch (error) {
      return res
        .status(400)
        .json({ error: "Invalid sender public key format." });
    }

    const transaction = new Transaction();

    // Process each recipient
    for (const recipient of recipients) {
      const { recipientPublicKey, amount } = recipient;

      if (!recipientPublicKey || isNaN(amount) || amount <= 0) {
        return res.status(400).json({
          error:
            "Each recipient must have a valid public key and a positive amount.",
        });
      }

      let recipientKey;
      try {
        recipientKey = new PublicKey(recipientPublicKey);
      } catch (error) {
        return res
          .status(400)
          .json({ error: "Invalid recipient public key format." });
      }

      if (tokenName.toLowerCase() === "sol") {
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: sender,
            toPubkey: recipientKey,
            lamports: amount * 1e9,
          })
        );
      } else {
        const mintAddress = tokenMintAccounts[tokenName.toLowerCase()];
        if (!mintAddress) {
          return res.status(400).json({ error: "Token not supported." });
        }

        const mint = new PublicKey(mintAddress);
        const senderTokenAccount = await getAssociatedTokenAddress(
          mint,
          sender
        );
        const recipientTokenAccount = await getAssociatedTokenAddress(
          mint,
          recipientKey
        );
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

        transaction.add(
          createTransferInstruction(
            senderTokenAccount,
            recipientTokenAccount,
            sender,
            amount,
            [],
            TOKEN_PROGRAM_ID
          )
        );
      }
    }

    // Add fee to company's public key
    const companyKey = new PublicKey(companyPublicKey);
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: sender,
        toPubkey: companyKey,
        lamports: feeInLamports,
      })
    );

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = sender;

    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    res.status(200).json({
      transaction: serializedTransaction.toString("base64"),
      tenantId: tenant.id, // Include tenant ID in response
    });
  } catch (error) {
    console.error("Error creating transaction:", error);
    res.status(500).json({ error: "Failed to create transaction" });
  }
};

export const submitTransaction = async (req: TenantRequest, res: Response) => {
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

    // Submit to blockchain
    const signature = await connection.sendRawTransaction(
      transaction.serialize()
    );
    await connection.confirmTransaction(signature, "confirmed");

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
  } catch (error) {
    console.error("Error submitting transaction:", error);
    res.status(500).json({ error: "Failed to submit transaction" });
  } finally {
    await db.$disconnect();
  }
};
