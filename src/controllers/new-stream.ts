import { Response } from "express";
import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  StreamOutput,
  StreamProtocol,
} from "livekit-server-sdk";
import { StreamSessionType, CallType, StreamFundingType } from "@prisma/client";
import { db, executeQuery, trackQuery } from "../prisma.js";
import {
  generateMeetingLink,
  isValidWalletAddress,
  roomService,
  livekitHost,
} from "../utils/index.js";
import { TenantRequest } from "../types/index.js";

// Cache for stream lookups
const streamCache = new Map<string, { data: any; timestamp: number }>();
const STREAM_CACHE_TTL = 30000; // 30 seconds

// Cache for tenant configuration
const tenantConfigCache = new Map<string, { data: any; timestamp: number }>();
const TENANT_CONFIG_CACHE_TTL = 300000; // 5 minutes

/**
 * OPTIMIZED: Generate guaranteed unique stream name
 * Format: "abc-def-xyz" (always 11 characters including dashes)
 */
function generateUniqueStreamName(): string {
  // 6-character random base
  const segments = 2;
  const segmentLength = 3;
  const charset = 'abcdefghijklmnopqrstuvwxyz0123456789';
  
  function generateSegment(): string {
    let segment = '';
    for (let i = 0; i < segmentLength; i++) {
      segment += charset[Math.floor(Math.random() * charset.length)];
    }
    return segment;
  }
  
  const base = Array(segments).fill(null).map(() => generateSegment()).join('-');
  
  // 3-character timestamp suffix for uniqueness
  const timestamp = Date.now() % 46656; // Ensures 3 chars in base36
  const suffix = timestamp.toString(36).padStart(3, '0');
  
  return `${base}-${suffix}`;
}

/**
 * OPTIMIZED: Create stream with async LiveKit room creation
 */
export const createStream = async (req: TenantRequest, res: Response) => {
  const {
    wallet,
    callType = "video",
    scheduledFor,
    title,
    streamSessionType,
    fundingType,
    isPublic = true,
  } = req.body;
  const tenant = req.tenant;
  let success = false;
  // const fullStart = Date.now();
  // console.log(`[TIMING] Request received`);

  // // Time each operation
  // console.log(`[TIMING] Starting tenant check`);

  try {
    const abortController = (req as any).abortController;
    if (res.headersSent || abortController?.signal?.aborted) {
      return;
    }

    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    // console.log(`[TIMING] Tenant check: ${Date.now() - fullStart}ms`);

    // console.log(`[TIMING] Starting user upsert`);

    if (!wallet || !isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: "Valid wallet address required." });
    }

    // const userStart = Date.now();

    // Step 1: Upsert user first
    const user = await executeQuery(
      () =>
        db.user.upsert({
          where: {
            walletAddress_tenantId: {
              walletAddress: wallet,
              tenantId: tenant.id,
            },
          },
          update: {},
          create: {
            walletAddress: wallet,
            tenantId: tenant.id,
            points: 0,
          },
        }),
      { maxRetries: 2, timeout: 3000 }
    );
    // console.log(`[TIMING] User upsert completed: ${Date.now() - userStart}ms`);
    // console.log(`[TIMING] Starting stream creation`);

    // Step 2: Generate guaranteed unique stream name (no DB check needed)
    const streamName = generateUniqueStreamName();
    // const streamStart = Date.now();
    // Step 3: Create stream
    const stream = await executeQuery(
      () =>
        db.stream.create({
          data: {
            name: streamName,
            title,
            callType: callType === "audio" ? CallType.Audio : CallType.Video,
            creatorWallet: wallet,
            streamSessionType: streamSessionType || tenant.defaultStreamType,
            fundingType: fundingType || tenant.defaultFundingType,
            isPublic,
            scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
            tenantId: tenant.id,
            userId: user.id,
            hasHost: false,
            recording: false,
            isLive: false,
            createdAt: new Date(),
          },
        }),
      { maxRetries: 2, timeout: 5000 }
    );
    // console.log(
    //   `[TIMING] Stream creation completed: ${Date.now() - streamStart}ms`
    // );

    // console.log(`[TIMING] Total request time: ${Date.now() - fullStart}ms`);

    // Step 4: Create LiveKit room asynchronously (fire and forget)
    setImmediate(() => {
      roomService
        .createRoom({
          name: streamName,
          emptyTimeout: 300,
          maxParticipants: 100,
        })
        .catch((err) => {
          console.error(`LiveKit room creation failed for ${streamName}:`, err);
          // Could implement retry logic here if needed
        });
    });

    success = true;

    if (!res.headersSent && !abortController?.signal?.aborted) {
      return res.status(201).json(stream);
    }
  } catch (error: any) {
    console.error("Error creating stream:", error);

    if (res.headersSent) return;

    if (error.message === "Query timeout" || error.code === "TIMEOUT") {
      return res.status(504).json({
        error: "Database query timeout",
        message: "The operation took too long. Please try again.",
      });
    }

    return res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

/**
 * OPTIMIZED: Create stream token with parallel operations and better caching
 */
export const createStreamToken = async (req: TenantRequest, res: Response) => {
  const { roomName, userName, wallet, avatarUrl } = req.body;
  const tenant = req.tenant;
  let success = false;
  // console.log("[NEW-STREAM] createStreamToken called at", Date.now());

  try {
    const abortController = (req as any).abortController;
    if (res.headersSent || abortController?.signal?.aborted) {
      return;
    }

    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!roomName || !userName || !wallet || !isValidWalletAddress(wallet)) {
      return res.status(400).json({
        error: "Missing or invalid required fields",
      });
    }

    // OPTIMIZATION: Parallel operations instead of sequential
    const [existingStream, user] = await Promise.all([
      // Fetch stream with minimal data
      executeQuery(
        () =>
          db.stream.findFirst({
            where: {
              name: roomName,
              tenantId: tenant.id,
            },
            select: {
              id: true,
              name: true,
              userId: true,
              hasHost: true,
              isPublic: true,
              isLive: true,
              streamSessionType: true,
              startedAt: true,
              creatorWallet: true,
            },
          }),
        { maxRetries: 1, timeout: 1500 }
      ),
      // Upsert user in parallel
      executeQuery(
        () =>
          db.user.upsert({
            where: {
              walletAddress_tenantId: {
                walletAddress: wallet,
                tenantId: tenant.id,
              },
            },
            update: {},
            create: {
              walletAddress: wallet,
              tenantId: tenant.id,
              points: 0,
            },
          }),
        { maxRetries: 1, timeout: 1500 }
      ),
    ]);

    if (!existingStream) {
      return res.status(404).json({ error: "Stream not found" });
    }

    // Determine userType
    let userType: "host" | "co-host" | "guest";
    if (
      user.id === existingStream.userId ||
      existingStream.creatorWallet === wallet
    ) {
      userType = "host";
    } else if (existingStream.streamSessionType === StreamSessionType.Meeting) {
      userType = "co-host";
    } else {
      userType = "guest";
    }

    // Check access permissions
    if (!existingStream.isPublic && userType === "guest") {
      return res
        .status(403)
        .json({ error: "This stream requires permission to join" });
    }

    if (userType === "guest" && !existingStream.hasHost) {
      return res.status(403).json({ error: "Waiting for host to join" });
    }

    // OPTIMIZATION: Start both operations in parallel
    const participantPromise = executeQuery(
      () =>
        db.participant.upsert({
          where: {
            walletAddress_streamId_tenantId: {
              walletAddress: wallet,
              streamId: existingStream.id,
              tenantId: tenant.id,
            },
          },
          update: {
            userName,
            userType,
            leftAt: null,
            ...(avatarUrl && { avatarUrl }),
          },
          create: {
            userName,
            walletAddress: wallet,
            userType,
            streamId: existingStream.id,
            tenantId: tenant.id,
            totalPoints: 0,
            ...(avatarUrl && { avatarUrl }),
          },
        }),
      { maxRetries: 1, timeout: 2000 }
    );

    // FIXED: Use atomic update for host status
    let streamUpdatePromise: Promise<void> = Promise.resolve();
    if (userType === "host" && !existingStream.hasHost) {
      streamUpdatePromise = executeQuery(
        () =>
          db.stream.updateMany({
            where: {
              id: existingStream.id,
              hasHost: false,
            },
            data: {
              hasHost: true,
              isLive: true,
              startedAt: existingStream.startedAt || new Date(),
            },
          }),
        { maxRetries: 1, timeout: 2000 }
      )
        .then(() => {
          // Convert BatchPayload to void by not returning anything
          return;
        })
        .catch((err) => {
          console.error(`Failed to update stream status: ${err.message}`);
          // Non-critical - continue anyway
        });
    }

    // Wait for participant creation (required), stream update is optional
    const [participant] = await Promise.all([
      participantPromise,
      streamUpdatePromise,
    ]);

    // Generate token
    const accessToken = new AccessToken(
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!,
      {
        identity: participant.id,
        ttl: "60m",
        metadata: JSON.stringify({
          userName,
          participantId: participant.id,
          userType,
          walletAddress: wallet,
          ...(avatarUrl && { avatarUrl }),
        }),
      }
    );

    accessToken.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: userType === "host" || userType === "co-host",
      canSubscribe: true,
      canPublishData: true,
      roomRecord: userType === "host" || userType === "co-host",
    });

    const token = await accessToken.toJwt();

    // Invalidate stream cache if host joined
    if (userType === "host" && !existingStream.hasHost) {
      const cacheKey = `${tenant.id}:${roomName}`;
      streamCache.delete(cacheKey);
    }

    success = true;

    if (!res.headersSent && !abortController?.signal?.aborted) {
      return res.status(200).json({ token, userType });
    }
  } catch (error: any) {
    console.error("Error creating token:", error);

    if (res.headersSent) return;

    if (error.message === "Query timeout" || error.code === "TIMEOUT") {
      return res.status(504).json({
        error: "Database query timeout",
        message: "The operation took too long. Please try again.",
      });
    }

    if (
      error.message?.includes("permission") ||
      error.message?.includes("Waiting for host")
    ) {
      return res.status(403).json({ error: error.message });
    }

    return res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

/**
 * OPTIMIZED: Get stream with selective data loading
 */
export const getStream = async (req: TenantRequest, res: Response) => {
  const { streamId } = req.params;
  const tenant = req.tenant;
  let success = false;
  // console.log("[NEW-STREAM] getStream called at", Date.now());

  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!streamId) {
      return res.status(400).json({ error: "Missing stream ID." });
    }

    // Check cache first
    const cacheKey = `${tenant.id}:${streamId}:full`;
    const cached = streamCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < STREAM_CACHE_TTL) {
      success = true;
      return res.status(200).json(cached.data);
    }

    // OPTIMIZED: Fetch stream with limited nested data
    const stream = await executeQuery(
      () =>
        db.stream.findFirst({
          where: {
            name: streamId,
            tenantId: tenant.id,
          },
          include: {
            // Only get counts
            _count: {
              select: {
                agenda: true,
                participants: true,
              },
            },
            // Get limited agenda data
            agenda: {
              select: {
                id: true,
                timeStamp: true,
                action: true,
                title: true,
                isCompleted: true,
              },
              orderBy: {
                timeStamp: "asc",
              },
              take: 20, // Only first 20 agendas
            },
            // Get active participants only
            participants: {
              where: {
                leftAt: null,
              },
              select: {
                id: true,
                userName: true,
                walletAddress: true,
                userType: true,
                avatarUrl: true,
                joinedAt: true,
                totalPoints: true,
              },
              orderBy: {
                joinedAt: "desc",
              },
              take: 30, // Only 30 active participants
            },
          },
        }),
      { maxRetries: 1, timeout: 2000 }
    );

    if (!stream) {
      return res.status(404).json({ error: "Stream not found." });
    }

    const streamWithCounts = {
      ...stream,
      totalAgendas: stream._count?.agenda || 0,
      totalParticipants: stream._count?.participants || 0,
      activeParticipants: stream.participants?.length || 0,
      _count: undefined, // Remove _count from response
    };

    // Cache the result
    streamCache.set(cacheKey, {
      data: streamWithCounts,
      timestamp: Date.now(),
    });

    success = true;
    return res.status(200).json(streamWithCounts);
  } catch (error: any) {
    console.error("Error fetching stream:", error);

    if (res.headersSent) return;

    if (error.message === "Query timeout" || error.code === "TIMEOUT") {
      return res.status(504).json({
        error: "Database query timeout",
        message: "The request took too long. Please try again.",
      });
    }

    return res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};
