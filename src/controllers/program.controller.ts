import { Response } from "express";
import { PublicKey, Keypair } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { db } from "../prisma.js";
import { TenantRequest } from "../types/index.js";
import { connection, isValidWalletAddress } from "../utils/index.js";
import { ProgramStreamStatus, StreamFundingType } from "@prisma/client";


// // Set up directory and load IDL
const __dirname = dirname(fileURLToPath(import.meta.url));
const vidbloqIdl = JSON.parse(
  readFileSync(join(__dirname, "../../src/idl/vidbloq_program.json"), "utf-8")
);

// Program ID from IDL
const PROGRAM_ID = new PublicKey(vidbloqIdl.address);

const { Program, AnchorProvider, BN, web3 } = anchor;

// // Create a read-only provider
const getReadOnlyProvider = () => {
  const dummyKeypair = Keypair.generate();
  return new AnchorProvider(
    connection,
    {
      publicKey: dummyKeypair.publicKey,
      signTransaction: async (tx) => tx,
      signAllTransactions: async (txs) => txs,
    },
    { commitment: "confirmed" }
  );
};

// // Initialize program with IDL
const initializeProgram = () => {
  const provider = getReadOnlyProvider();
  return new Program(vidbloqIdl as any, provider);
};

// // Get PDA for a stream
const getStreamPDA = (streamName: string, hostPublicKey: PublicKey) => {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stream"), Buffer.from(streamName), hostPublicKey.toBuffer()],
    PROGRAM_ID
  );
  return pda;
};

// Get PDA for a donor account
const getDonorPDA = (streamPDA: PublicKey, donorPublicKey: PublicKey) => {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("donor"), streamPDA.toBuffer(), donorPublicKey.toBuffer()],
    PROGRAM_ID
  );
  return pda;
};

// // Helper to deserialize instruction
const deserializeInstruction = (serializedIx: any) => {
  return {
    keys: serializedIx.keys.map((k: any) => ({
      pubkey: k.pubkey.toString(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    programId: serializedIx.programId.toString(),
    data: Buffer.from(serializedIx.data).toString("base64"),
  };
};

/**
 * Controller for getting a stream PDA
 */
export const getStreamPDAController = async (req: TenantRequest, res: Response) => {
  const { streamName, hostPublicKey } = req.query;
  const tenant = req.tenant;

  try {
    // Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!streamName || !hostPublicKey) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    // Validate host wallet belongs to this tenant
    if (typeof hostPublicKey === 'string' && isValidWalletAddress(hostPublicKey)) {
      const hostUser = await db.user.findFirst({
        where: {
          walletAddress: hostPublicKey,
          tenantId: tenant.id,
        },
      });

      if (!hostUser) {
        // Optionally create the user if they don't exist
        await db.user.create({
          data: {
            walletAddress: hostPublicKey,
            tenantId: tenant.id,
          },
        });
      }
    }

    const pda = getStreamPDA(
      streamName as string,
      new PublicKey(hostPublicKey as string)
    );

    return res.status(200).json({ 
      pda: pda.toString(),
      tenantId: tenant.id
    });
  } catch (error) {
    console.error("Error getting stream PDA:", error);
    return res.status(500).json({ error: "Failed to get stream PDA" });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * Controller for building an initialize transaction
 */
export const buildInitializeTransactionController = async (
  req: TenantRequest,
  res: Response
) => {
  const { streamName, streamType, mintAddress, hostPublicKey, endTime } = req.body;
  const tenant = req.tenant;

  try {
    // Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!streamName || !streamType || !mintAddress || !hostPublicKey) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    // Validate host wallet
    if (!isValidWalletAddress(hostPublicKey)) {
      return res.status(400).json({ error: "Invalid host wallet address format." });
    }

    // Check if host user exists in tenant's context
    let hostUser = await db.user.findFirst({
      where: {
        walletAddress: hostPublicKey,
        tenantId: tenant.id,
      },
    });

    if (!hostUser) {
      // Create the user if they don't exist
      hostUser = await db.user.create({
        data: {
          walletAddress: hostPublicKey,
          tenantId: tenant.id,
        },
      });
    }

    const program = initializeProgram();
    const hostPubkey = new PublicKey(hostPublicKey);
    const mint = new PublicKey(mintAddress);

    const streamPDA = getStreamPDA(streamName, hostPubkey);
    const streamATA = await getAssociatedTokenAddress(mint, streamPDA, true);

    let streamTypeData;
    switch (streamType) {
      case StreamFundingType.Live:
        streamTypeData = { live: {} };
        break;
      case StreamFundingType.Prepaid:
        streamTypeData = {
          prepaid: {
            minDuration: new BN(0),
          },
        };
        break;
      case StreamFundingType.Conditional:
        streamTypeData = {
          conditional: {
            minAmount: null,
            unlockTime: null,
          },
        };
        break;
      default:
        return res.status(400).json({ error: "Invalid stream type" });
    }

    // Add both snake_case and camelCase accounts to ensure compatibility
    const accounts = {
      host: hostPubkey,
      stream: streamPDA,
      mint: mint,
      stream_ata: streamATA,
      streamAta: streamATA, // Add camelCase version
      system_program: web3.SystemProgram.programId,
      systemProgram: web3.SystemProgram.programId, // Add camelCase version
      associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, // Add camelCase version
      token_program: TOKEN_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID, // Add camelCase version
    };

    const ix = await program.methods
      .initialize(streamName, streamTypeData, endTime ? new BN(endTime) : null)
      .accounts(accounts)
      .instruction();

    // Store the stream in the database (tenant-scoped)
    const streamRecord = await db.programStream.create({
      data: {
        name: streamName,
        streamType: streamType as StreamFundingType,
        streamPDA: streamPDA.toString(),
        streamATA: streamATA.toString(),
        mintAddress: mintAddress,
        hostWallet: hostPublicKey,
        endTime: endTime ? new Date(Number(endTime) * 1000) : null, // Convert from Unix timestamp if provided
        status: ProgramStreamStatus.Initialized,
        tenantId: tenant.id,
        userId: hostUser.id, // Link to host user
      },
    });

    return res.status(200).json({
      instruction: deserializeInstruction(ix),
      accounts: {
        streamPDA: streamPDA.toString(),
        streamATA: streamATA.toString(),
      },
      streamId: streamRecord.id,
      tenantId: tenant.id
    });
  } catch (error) {
    console.error("Error building initialize transaction:", error);
    return res.status(500).json({
      error: "Failed to build initialize transaction",
      details: error instanceof Error ? error.message : String(error),
    });
  }
  //  finally {
  //   await db.$disconnect();
  // }
};

/**
 * Controller for building a start stream transaction
 */
export const buildStartStreamTransactionController = async (
  req: TenantRequest,
  res: Response
) => {
  const { streamName, hostPublicKey } = req.body;
  const tenant = req.tenant;

  try {
    // Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!streamName || !hostPublicKey) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    // Validate wallet
    if (!isValidWalletAddress(hostPublicKey)) {
      return res.status(400).json({ error: "Invalid host wallet address format." });
    }

    // Check if stream exists in tenant's context
    const streamRecord = await db.programStream.findFirst({
      where: {
        name: streamName,
        hostWallet: hostPublicKey,
        tenantId: tenant.id,
      },
    });

    if (!streamRecord) {
      return res.status(404).json({ 
        error: "Stream not found for this tenant",
        details: "Please initialize the stream first" 
      });
    }

    const program = initializeProgram();
    const hostPubkey = new PublicKey(hostPublicKey);
    const streamPDA = getStreamPDA(streamName, hostPubkey);

    const ix = await program.methods
      .startStream()
      .accounts({
        host: hostPubkey,
        stream: streamPDA,
      })
      .instruction();

    // Update stream status in database
    await db.programStream.update({
      where: { id: streamRecord.id },
      data: {
        status: ProgramStreamStatus.Active,
        startedAt: new Date(),
      },
    });

    return res.status(200).json({
      instruction: deserializeInstruction(ix),
      accounts: {
        streamPDA: streamPDA.toString(),
      },
      streamId: streamRecord.id,
      tenantId: tenant.id
    });
  } catch (error) {
    console.error("Error building start stream transaction:", error);
    return res.status(500).json({
      error: "Failed to build start stream transaction",
      details: error instanceof Error ? error.message : String(error),
    });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * Controller for building a complete stream transaction
 */
export const buildCompleteStreamTransactionController = async (
  req: TenantRequest,
  res: Response
) => {
  const { streamName, hostPublicKey } = req.body;
  const tenant = req.tenant;

  try {
    // Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!streamName || !hostPublicKey) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    // Validate wallet
    if (!isValidWalletAddress(hostPublicKey)) {
      return res.status(400).json({ error: "Invalid host wallet address format." });
    }

    // Check if stream exists in tenant's context
    const streamRecord = await db.programStream.findFirst({
      where: {
        name: streamName,
        hostWallet: hostPublicKey,
        tenantId: tenant.id,
      },
    });

    if (!streamRecord) {
      return res.status(404).json({ 
        error: "Stream not found for this tenant" 
      });
    }

    const program = initializeProgram();
    const hostPubkey = new PublicKey(hostPublicKey);
    const streamPDA = getStreamPDA(streamName, hostPubkey);

    const ix = await program.methods
      .completeStream()
      .accounts({
        host: hostPubkey,
        stream: streamPDA,
      })
      .instruction();

    // Update stream status in database
    await db.programStream.update({
      where: { id: streamRecord.id },
      data: {
        status: ProgramStreamStatus.Completed,
        endedAt: new Date(),
      },
    });

    return res.status(200).json({
      instruction: deserializeInstruction(ix),
      accounts: {
        streamPDA: streamPDA.toString(),
      },
      streamId: streamRecord.id,
      tenantId: tenant.id
    });
  } catch (error) {
    console.error("Error building complete stream transaction:", error);
    return res.status(500).json({
      error: "Failed to build complete stream transaction",
      details: error instanceof Error ? error.message : String(error),
    });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * Controller for building a deposit transaction
 */
export const buildDepositTransactionController = async (
  req: TenantRequest,
  res: Response
) => {
  const {
    streamName,
    hostPublicKey,
    donorPublicKey,
    amount,
    donorATA,
    streamATA,
  } = req.body;
  const tenant = req.tenant;

  try {
    // Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (
      !streamName ||
      !hostPublicKey ||
      !donorPublicKey ||
      !amount ||
      !donorATA ||
      !streamATA
    ) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    // Validate wallets
    if (!isValidWalletAddress(hostPublicKey) || !isValidWalletAddress(donorPublicKey)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    // Check if stream exists for this tenant
    const streamRecord = await db.programStream.findFirst({
      where: {
        name: streamName,
        hostWallet: hostPublicKey,
        tenantId: tenant.id,
      },
    });

    if (!streamRecord) {
      return res.status(404).json({ 
        error: "Stream not found for this tenant" 
      });
    }

    // Find or create donor user
    let donorUser = await db.user.findFirst({
      where: {
        walletAddress: donorPublicKey,
        tenantId: tenant.id,
      },
    });

    if (!donorUser) {
      donorUser = await db.user.create({
        data: {
          walletAddress: donorPublicKey,
          tenantId: tenant.id,
        },
      });
    }

    const program = initializeProgram();
    const hostPubkey = new PublicKey(hostPublicKey);
    const donorPubkey = new PublicKey(donorPublicKey);
    const streamPDA = getStreamPDA(streamName, hostPubkey);
    const donorPDA = getDonorPDA(streamPDA, donorPubkey);

    // Create accounts object with both naming styles
    const accounts = {
      // Snake_case versions (directly from IDL)
      donor: donorPubkey,
      stream: streamPDA,
      donor_account: donorPDA,
      donor_ata: new PublicKey(donorATA),
      stream_ata: new PublicKey(streamATA),
      system_program: web3.SystemProgram.programId,
      associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
      token_program: TOKEN_PROGRAM_ID,

      // CamelCase versions (for compatibility)
      donorAccount: donorPDA,
      donorAta: new PublicKey(donorATA),
      streamAta: new PublicKey(streamATA),
      systemProgram: web3.SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID
    };

    const ix = await program.methods
      .deposit(new BN(amount))
      .accounts(accounts)
      .instruction();

    // Record donation in database
    const donationRecord = await db.streamDonation.create({
      data: {
        amount: amount.toString(),
        donorWallet: donorPublicKey,
        streamId: streamRecord.id,
        tenantId: tenant.id,
        userId: donorUser.id,
        donorPDA: donorPDA.toString(),
        status: "pending",
      },
    });

    return res.status(200).json({
      instruction: deserializeInstruction(ix),
      accounts: {
        streamPDA: streamPDA.toString(),
        donorPDA: donorPDA.toString(),
      },
      donationId: donationRecord.id,
      tenantId: tenant.id
    });
  } catch (error) {
    console.error("Error building deposit transaction:", error);
    return res.status(500).json({
      error: "Failed to build deposit transaction",
      details: error instanceof Error ? error.message : String(error),
    });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * Controller for building a distribute transaction
 */
export const buildDistributeTransactionController = async (
  req: TenantRequest,
  res: Response
) => {
  const {
    streamName,
    hostPublicKey,
    recipientPublicKey,
    amount,
    mintAddress,
    streamATA,
    recipientATA,
  } = req.body;
  const tenant = req.tenant;

  try {
    // Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (
      !streamName ||
      !hostPublicKey ||
      !recipientPublicKey ||
      !amount ||
      !mintAddress ||
      !streamATA ||
      !recipientATA
    ) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    // Validate wallets
    if (!isValidWalletAddress(hostPublicKey) || !isValidWalletAddress(recipientPublicKey)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    // Check if stream exists for this tenant
    const streamRecord = await db.programStream.findFirst({
      where: {
        name: streamName,
        hostWallet: hostPublicKey,
        tenantId: tenant.id,
      },
    });

    if (!streamRecord) {
      return res.status(404).json({ 
        error: "Stream not found for this tenant" 
      });
    }

    // Find or create recipient user
    let recipientUser = await db.user.findFirst({
      where: {
        walletAddress: recipientPublicKey,
        tenantId: tenant.id,
      },
    });

    if (!recipientUser) {
      recipientUser = await db.user.create({
        data: {
          walletAddress: recipientPublicKey,
          tenantId: tenant.id,
        },
      });
    }

    const program = initializeProgram();
    const hostPubkey = new PublicKey(hostPublicKey);
    const recipientPubkey = new PublicKey(recipientPublicKey);
    const mint = new PublicKey(mintAddress);
    const streamPDA = getStreamPDA(streamName, hostPubkey);

    // Prepare accounts object with both naming styles
    const accounts = {
      // Snake_case versions (directly from IDL)
      host: hostPubkey,
      recipient: recipientPubkey,
      mint: mint,
      stream: streamPDA,
      stream_ata: new PublicKey(streamATA),
      recipient_ata: new PublicKey(recipientATA),
      system_program: web3.SystemProgram.programId,
      associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
      token_program: TOKEN_PROGRAM_ID,
      
      // CamelCase versions (for compatibility)
      streamAta: new PublicKey(streamATA),
      recipientAta: new PublicKey(recipientATA),
      systemProgram: web3.SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID
    };

    const ix = await program.methods
      .distribute(new BN(amount))
      .accounts(accounts)
      .instruction();

    // Record distribution in database
    const distributionRecord = await db.streamDistribution.create({
      data: {
        amount: amount.toString(),
        recipientWallet: recipientPublicKey,
        streamId: streamRecord.id,
        tenantId: tenant.id,
        userId: recipientUser.id,
        status: "pending",
      },
    });

    return res.status(200).json({
      instruction: deserializeInstruction(ix),
      accounts: {
        streamPDA: streamPDA.toString(),
      },
      distributionId: distributionRecord.id,
      tenantId: tenant.id
    });
  } catch (error) {
    console.error("Error building distribute transaction:", error);
    return res.status(500).json({
      error: "Failed to build distribute transaction",
      details: error instanceof Error ? error.message : String(error),
    });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * Controller for building a refund transaction
 */
export const buildRefundTransactionController = async (
  req: TenantRequest,
  res: Response
) => {
  const {
    streamName,
    hostPublicKey,
    donorPublicKey,
    initiatorPublicKey,
    amount,
    donorATA,
    streamATA,
  } = req.body;
  const tenant = req.tenant;

  try {
    // Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (
      !streamName ||
      !hostPublicKey ||
      !donorPublicKey ||
      !initiatorPublicKey ||
      !amount ||
      !donorATA ||
      !streamATA
    ) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    // Validate wallets
    if (!isValidWalletAddress(hostPublicKey) || 
        !isValidWalletAddress(donorPublicKey) || 
        !isValidWalletAddress(initiatorPublicKey)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    // Check if stream exists for this tenant
    const streamRecord = await db.programStream.findFirst({
      where: {
        name: streamName,
        hostWallet: hostPublicKey,
        tenantId: tenant.id,
      },
    });

    if (!streamRecord) {
      return res.status(404).json({ 
        error: "Stream not found for this tenant" 
      });
    }

    // Find donor user
    const donorUser = await db.user.findFirst({
      where: {
        walletAddress: donorPublicKey,
        tenantId: tenant.id,
      },
    });

    if (!donorUser) {
      return res.status(404).json({ 
        error: "Donor not found for this tenant" 
      });
    }

    // Find donation record
    const donationRecord = await db.streamDonation.findFirst({
      where: {
        streamId: streamRecord.id,
        donorWallet: donorPublicKey,
        tenantId: tenant.id,
      },
    });

    if (!donationRecord) {
      return res.status(404).json({ 
        error: "Donation record not found for this donor and stream" 
      });
    }

    const program = initializeProgram();
    const hostPubkey = new PublicKey(hostPublicKey);
    const donorPubkey = new PublicKey(donorPublicKey);
    const initiatorPubkey = new PublicKey(initiatorPublicKey);
    const streamPDA = getStreamPDA(streamName, hostPubkey);
    const donorPDA = getDonorPDA(streamPDA, donorPubkey);

    // Prepare accounts object with both naming styles
    const accounts = {
      // Snake_case versions
      donor: donorPubkey,
      initiator: initiatorPubkey,
      stream: streamPDA,
      donor_account: donorPDA,
      donor_ata: new PublicKey(donorATA),
      stream_ata: new PublicKey(streamATA),
      associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
      token_program: TOKEN_PROGRAM_ID,
      
      // CamelCase versions
      donorAccount: donorPDA,
      donorAta: new PublicKey(donorATA),
      streamAta: new PublicKey(streamATA),
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID
    };

    const ix = await program.methods
      .refund(new BN(amount))
      .accounts(accounts)
      .instruction();

    // Update donation record in database
    await db.streamDonation.update({
      where: { id: donationRecord.id },
      data: {
        refundPending: true,
        refundAmount: amount.toString(),
        refundInitiator: initiatorPublicKey,
      },
    });

    return res.status(200).json({
      instruction: deserializeInstruction(ix),
      accounts: {
        streamPDA: streamPDA.toString(),
        donorPDA: donorPDA.toString(),
      },
      donationId: donationRecord.id,
      tenantId: tenant.id
    });
  } catch (error) {
    console.error("Error building refund transaction:", error);
    return res.status(500).json({
      error: "Failed to build refund transaction",
      details: error instanceof Error ? error.message : String(error),
    });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * Controller for building an update stream transaction
 */
export const buildUpdateStreamTransactionController = async (
  req: TenantRequest,
  res: Response
) => {
  const { streamName, hostPublicKey, newEndTime, newStatus } = req.body;
  const tenant = req.tenant;

  try {
    // Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!streamName || !hostPublicKey) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    // Validate wallet
    if (!isValidWalletAddress(hostPublicKey)) {
      return res.status(400).json({ error: "Invalid host wallet address format." });
    }

    // Check if stream exists for this tenant
    const streamRecord = await db.programStream.findFirst({
      where: {
        name: streamName,
        hostWallet: hostPublicKey,
        tenantId: tenant.id,
      },
    });

    if (!streamRecord) {
      return res.status(404).json({ 
        error: "Stream not found for this tenant" 
      });
    }

    const program = initializeProgram();
    const hostPubkey = new PublicKey(hostPublicKey);
    const streamPDA = getStreamPDA(streamName, hostPubkey);

    let statusData;
    let dbStatus;
    
    if (newStatus) {
      switch (newStatus) {
        case "active":
          statusData = { active: {} };
          dbStatus = ProgramStreamStatus.Active;
          break;
        case "ended":
          statusData = { ended: {} };
          dbStatus = ProgramStreamStatus.Completed;
          break;
        case "cancelled":
          statusData = { cancelled: {} };
          dbStatus = ProgramStreamStatus.Cancelled;
          break;
        default:
          return res.status(400).json({ error: "Invalid status" });
      }
    }

    const ix = await program.methods
      .updateStream(
        newEndTime ? new BN(newEndTime) : null,
        newStatus ? statusData : null
      )
      .accounts({
        host: hostPubkey,
        stream: streamPDA,
      })
      .instruction();

    // Update stream in database
    const dbUpdateData: any = {};
    
    if (newEndTime) {
      dbUpdateData.endTime = new Date(Number(newEndTime) * 1000);
    }
    
    if (dbStatus) {
      dbUpdateData.status = dbStatus;
      if (dbStatus === ProgramStreamStatus.Completed || dbStatus === ProgramStreamStatus.Cancelled) {
        dbUpdateData.endedAt = new Date();
      }
    }
    
    await db.programStream.update({
      where: { id: streamRecord.id },
      data: dbUpdateData,
    });

    return res.status(200).json({
      instruction: deserializeInstruction(ix),
      accounts: {
        streamPDA: streamPDA.toString(),
      },
      streamId: streamRecord.id,
      tenantId: tenant.id
    });
  } catch (error) {
    console.error("Error building update stream transaction:", error);
    return res.status(500).json({
      error: "Failed to build update stream transaction",
      details: error instanceof Error ? error.message : String(error),
    });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};


/**
 * Controller for listing stream donations
 */
export const listDonationsController = async (req: TenantRequest, res: Response) => {
  const { streamId, donorWallet, limit, offset } = req.query;
  const tenant = req.tenant;

  try {
    // Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!streamId) {
      return res.status(400).json({ error: "streamId is required" });
    }

    // Verify stream belongs to tenant
    const stream = await db.programStream.findFirst({
      where: {
        id: streamId as string,
        tenantId: tenant.id,
      },
    });

    if (!stream) {
      return res.status(404).json({ error: "Stream not found for this tenant" });
    }

    // Build query filters
    const filters: any = {
      streamId: streamId as string,
      tenantId: tenant.id,
    };

    if (donorWallet) {
      filters.donorWallet = donorWallet as string;
    }

    // Parse pagination params
    const parsedLimit = limit ? parseInt(limit as string) : 10;
    const parsedOffset = offset ? parseInt(offset as string) : 0;

    // Get donations
    const donations = await db.streamDonation.findMany({
      where: filters,
      take: parsedLimit,
      skip: parsedOffset,
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Get total count for pagination
    const totalCount = await db.streamDonation.count({
      where: filters,
    });

    return res.status(200).json({
      donations,
      pagination: {
        total: totalCount,
        limit: parsedLimit,
        offset: parsedOffset,
        hasMore: parsedOffset + donations.length < totalCount,
      },
    });
  } catch (error) {
    console.error("Error listing donations:", error);
    return res.status(500).json({
      error: "Failed to list donations",
      details: error instanceof Error ? error.message : String(error),
    });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * Controller for listing stream distributions
 */
export const listDistributionsController = async (req: TenantRequest, res: Response) => {
  const { streamId, recipientWallet, limit, offset } = req.query;
  const tenant = req.tenant;

  try {
    // Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!streamId) {
      return res.status(400).json({ error: "streamId is required" });
    }

    // Verify stream belongs to tenant
    const stream = await db.programStream.findFirst({
      where: {
        id: streamId as string,
        tenantId: tenant.id,
      },
    });

    if (!stream) {
      return res.status(404).json({ error: "Stream not found for this tenant" });
    }

    // Build query filters
    const filters: any = {
      streamId: streamId as string,
      tenantId: tenant.id,
    };

    if (recipientWallet) {
      filters.recipientWallet = recipientWallet as string;
    }

    // Parse pagination params
    const parsedLimit = limit ? parseInt(limit as string) : 10;
    const parsedOffset = offset ? parseInt(offset as string) : 0;

    // Get distributions
    const distributions = await db.streamDistribution.findMany({
      where: filters,
      take: parsedLimit,
      skip: parsedOffset,
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Get total count for pagination
    const totalCount = await db.streamDistribution.count({
      where: filters,
    });

    return res.status(200).json({
      distributions,
      pagination: {
        total: totalCount,
        limit: parsedLimit,
        offset: parsedOffset,
        hasMore: parsedOffset + distributions.length < totalCount,
      },
    });
  } catch (error) {
    console.error("Error listing distributions:", error);
    return res.status(500).json({
      error: "Failed to list distributions",
      details: error instanceof Error ? error.message : String(error),
    });
  } 
  // finally {
  //   await db.$disconnect();
  // }
}; 

/**
 * Helper to convert BigInt values to strings for JSON serialization
 */
const serializeBigInt = (obj: any): any => {
  if (obj === null || obj === undefined) return obj;
  
  if (typeof obj === 'bigint') {
    return obj.toString();
  }
  
  if (Array.isArray(obj)) {
    return obj.map(serializeBigInt);
  }
  
  if (typeof obj === 'object') {
    const newObj: any = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        newObj[key] = serializeBigInt(obj[key]);
      }
    }
    return newObj;
  }
  
  return obj;
};

// Updated listStreamsController with BigInt serialization
export const listStreamsController = async (req: TenantRequest, res: Response) => {
  const { hostWallet, status, limit, offset } = req.query;
  const tenant = req.tenant;

  try {
    // Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    // Build query filters
    const filters: any = {
      tenantId: tenant.id,
    };

    if (hostWallet) {
      filters.hostWallet = hostWallet as string;
    }

    if (status) {
      filters.status = status as ProgramStreamStatus;
    }

    // Parse pagination params
    const parsedLimit = limit ? parseInt(limit as string) : 10;
    const parsedOffset = offset ? parseInt(offset as string) : 0;

    // Get streams
    const streams = await db.programStream.findMany({
      where: filters,
      include: {
        _count: {
          select: {
            donations: true,
            distributions: true,
          },
        },
      },
      take: parsedLimit,
      skip: parsedOffset,
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Get total count for pagination
    const totalCount = await db.programStream.count({
      where: filters,
    });

    // Serialize BigInt values
    const serializedStreams = streams.map(stream => ({
      ...stream,
      totalDeposited: stream.totalDeposited.toString(),
      totalDistributed: stream.totalDistributed.toString(),
    }));

    return res.status(200).json({
      streams: serializedStreams,
      pagination: {
        total: totalCount,
        limit: parsedLimit,
        offset: parsedOffset,
        hasMore: parsedOffset + streams.length < totalCount,
      },
    });
  } catch (error) {
    console.error("Error listing streams:", error);
    return res.status(500).json({
      error: "Failed to list streams",
      details: error instanceof Error ? error.message : String(error),
    });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

// Updated recordTransactionController to handle transaction type correctly
export const recordTransactionController = async (req: TenantRequest, res: Response) => {
  const { 
    signature, 
    transactionType, 
    streamId, 
    donationId, 
    distributionId, 
    wallet 
  } = req.body;
  const tenant = req.tenant;

  try {
    // Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!signature || !transactionType || !wallet) {
      return res.status(400).json({
        error: "Missing required parameters: signature, transactionType, and wallet"
      });
    }

    // Normalize transaction type (handle both formats)
    const normalizedTransactionType = transactionType.replace('-', '').toLowerCase();

    // Validate wallet
    if (!isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    // Get user
    const user = await db.user.findFirst({
      where: {
        walletAddress: wallet,
        tenantId: tenant.id,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found for this tenant" });
    }

    // Verify transaction on Solana blockchain
    try {
      const txStatus = await connection.confirmTransaction(signature, "confirmed");
      
      if (txStatus.value.err) {
        return res.status(400).json({ 
          error: "Transaction failed on blockchain",
          details: txStatus.value.err
        });
      }
    } catch (err) {
      return res.status(400).json({ 
        error: "Failed to verify transaction",
        details: err instanceof Error ? err.message : String(err)
      });
    }

    // Record transaction in database based on type
    let updatedRecord;
    switch (normalizedTransactionType) {
      case "initialize":
        if (!streamId) {
          return res.status(400).json({ error: "streamId required for initialize transaction" });
        }

        updatedRecord = await db.programStream.update({
          where: {
            id: streamId,
            tenantId: tenant.id,
          },
          data: {
            transactionSignature: signature,
            isInitialized: true,
          },
        });

        if (!updatedRecord) {
          return res.status(404).json({ error: "Stream not found for this tenant" });
        }
        break;

      case "start":
      case "startstream":
        if (!streamId) {
          return res.status(400).json({ error: "streamId required for start transaction" });
        }

        updatedRecord = await db.programStream.update({
          where: {
            id: streamId,
            tenantId: tenant.id,
          },
          data: {
            status: ProgramStreamStatus.Active,
            startedAt: new Date(),
            startTransactionSignature: signature,
          },
        });

        if (!updatedRecord) {
          return res.status(404).json({ error: "Stream not found for this tenant" });
        }
        break;

      case "complete":
      case "completestream":
        if (!streamId) {
          return res.status(400).json({ error: "streamId required for complete transaction" });
        }

        updatedRecord = await db.programStream.update({
          where: {
            id: streamId,
            tenantId: tenant.id,
          },
          data: {
            status: ProgramStreamStatus.Completed,
            endedAt: new Date(),
            completeTransactionSignature: signature,
          },
        });

        if (!updatedRecord) {
          return res.status(404).json({ error: "Stream not found for this tenant" });
        }
        break;

      case "deposit":
        if (!donationId) {
          return res.status(400).json({ error: "donationId required for deposit transaction" });
        }

        updatedRecord = await db.streamDonation.update({
          where: {
            id: donationId,
            tenantId: tenant.id,
          },
          data: {
            status: "confirmed",
            transactionSignature: signature,
            confirmedAt: new Date(),
          },
        });

        if (!updatedRecord) {
          return res.status(404).json({ error: "Donation not found for this tenant" });
        }

        // Increment stream total deposited
        await db.programStream.update({
          where: { id: updatedRecord.streamId },
          data: {
            totalDeposited: {
              increment: BigInt(updatedRecord.amount)
            }
          }
        });
        break;

      case "distribute":
        if (!distributionId) {
          return res.status(400).json({ error: "distributionId required for distribute transaction" });
        }

        updatedRecord = await db.streamDistribution.update({
          where: {
            id: distributionId,
            tenantId: tenant.id,
          },
          data: {
            status: "confirmed",
            transactionSignature: signature,
            confirmedAt: new Date(),
          },
        });

        if (!updatedRecord) {
          return res.status(404).json({ error: "Distribution not found for this tenant" });
        }

        // Increment stream total distributed
        await db.programStream.update({
          where: { id: updatedRecord.streamId },
          data: {
            totalDistributed: {
              increment: BigInt(updatedRecord.amount)
            }
          }
        });
        break;

      case "refund":
        if (!donationId) {
          return res.status(400).json({ error: "donationId required for refund transaction" });
        }

        updatedRecord = await db.streamDonation.update({
          where: {
            id: donationId,
            tenantId: tenant.id,
          },
          data: {
            refundConfirmed: true,
            refundedAt: new Date(),
            refundTransactionSignature: signature,
          },
        });

        if (!updatedRecord) {
          return res.status(404).json({ error: "Donation not found for this tenant" });
        }
        break;

      case "update":
      case "updatestream":
        if (!streamId) {
          return res.status(400).json({ error: "streamId required for update transaction" });
        }

        updatedRecord = await db.programStream.update({
          where: {
            id: streamId,
            tenantId: tenant.id,
          },
          data: {
            updateTransactionSignature: signature,
            updatedAt: new Date(),
          },
        });

        if (!updatedRecord) {
          return res.status(404).json({ error: "Stream not found for this tenant" });
        }
        break;

      default:
        return res.status(400).json({ error: `Invalid transaction type: ${transactionType}` });
    }

    // Serialize the updated record before sending
    const serializedRecord = serializeBigInt(updatedRecord);

    // Also store in general transactions table
    await db.transaction.create({
      data: {
        signature,
        transactionType: normalizedTransactionType,
        createdAt: new Date(),
        tenantId: tenant.id,
        userId: user.id,
        solanaStreamId: streamId || null,
        donationId: donationId || null,
        distributionId: distributionId || null
      },
    });

    return res.status(200).json({
      success: true,
      message: `${normalizedTransactionType} transaction recorded successfully`,
      signature,
      data: serializedRecord
    });
  } catch (error) {
    console.error("Error recording transaction:", error);
    return res.status(500).json({
      error: "Failed to record transaction",
      details: error instanceof Error ? error.message : String(error),
    });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

// Also update getStreamController to handle BigInt serialization
export const getStreamController = async (req: TenantRequest, res: Response) => {
  const { streamName, hostPublicKey } = req.query;
  const tenant = req.tenant;

  try {
    // Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!streamName || !hostPublicKey) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    // Fetch stream from database (tenant-scoped)
    const streamRecord = await db.programStream.findFirst({
      where: {
        name: streamName as string,
        hostWallet: hostPublicKey as string,
        tenantId: tenant.id,
      },
      include: {
        donations: true,
        distributions: true,
      },
    });

    if (!streamRecord) {
      return res.status(404).json({ error: "Stream not found for this tenant" });
    }

    // Serialize the stream record
    const serializedStream = serializeBigInt(streamRecord);

    // Get on-chain data
    try {
      const program = initializeProgram();
      const hostPubkey = new PublicKey(hostPublicKey as string);
      const streamPDA = getStreamPDA(streamName as string, hostPubkey);
      
      const onChainData = await (program.account as any).streamState.fetch(streamPDA);
      
      // Return combined data
      return res.status(200).json({
        stream: serializedStream,
        onChainData: {
          host: onChainData.host.toString(),
          streamName: onChainData.streamName,
          status: onChainData.status,
          totalDeposited: onChainData.totalDeposited.toString(),
          totalDistributed: onChainData.totalDistributed.toString(),
          createdAt: new Date(Number(onChainData.createdAt) * 1000),
          startTime: onChainData.startTime ? new Date(Number(onChainData.startTime) * 1000) : null,
          endTime: onChainData.endTime ? new Date(Number(onChainData.endTime) * 1000) : null,
          streamType: onChainData.streamType,
        }
      });
    } catch (error) {
      // Handle on-chain data fetch error
      console.error("Error fetching on-chain data:", error);
      
      // Return just the database record without on-chain data
      return res.status(200).json({
        stream: serializedStream,
        onChainData: null,
        onChainError: "Stream account not found on blockchain or failed to fetch on-chain data"
      });
    }
  } catch (error) {
    console.error("Error fetching stream:", error);
    return res.status(500).json({
      error: "Failed to fetch stream",
      details: error instanceof Error ? error.message : String(error),
    });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};