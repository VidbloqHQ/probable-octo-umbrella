import { Response } from "express";
import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  StreamOutput,
  StreamProtocol,
} from "livekit-server-sdk";
import { StreamSessionType, CallType, StreamFundingType } from "@prisma/client";
import { db, executeQuery, executeTransaction, trackQuery } from "../prisma.js";
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
 * Helper function to generate a unique stream name - OPTIMIZED
 */
async function generateUniqueStreamName(tenantId: string): Promise<string> {
  if (!tenantId) {
    throw new Error("Tenant ID is required to generate a unique stream name");
  }

  // Try up to 5 times to generate a unique name
  for (let attempt = 0; attempt < 5; attempt++) {
    const streamName = generateMeetingLink();

    // Check if the stream name is unique
    const existingStream = await executeQuery(
      () => db.stream.findFirst({
        where: {
          name: streamName,
          tenantId: tenantId,
        },
        select: { id: true }
      }),
      { maxRetries: 1, timeout: 5000 }
    );

    if (!existingStream) {
      return streamName;
    }
  }

  // Fallback with timestamp to ensure uniqueness
  return `${generateMeetingLink()}-${Date.now()}`;
}

/**
 * Helper function to get enabled stream types for a tenant
 */
function getEnabledStreamTypes(
  tenant: any,
  defaultTypes: any = null
): string[] {
  const enabledTypes = [];

  const effectiveTypes = tenant.enabledStreamTypes ||
    defaultTypes || {
      enableStream: true,
      enableMeeting: true,
      enablePodcast: false,
    };

  if (effectiveTypes.enableStream) {
    enabledTypes.push(StreamSessionType.Livestream);
  }

  if (effectiveTypes.enableMeeting) {
    enabledTypes.push(StreamSessionType.Meeting);
  }

  if (effectiveTypes.enablePodcast) {
    enabledTypes.push(StreamSessionType.Podcast);
  }

  return enabledTypes;
}

/**
 * Get tenant configuration with caching
 */
async function getTenantConfig(tenantId: string) {
  const cached = tenantConfigCache.get(tenantId);
  
  if (cached && Date.now() - cached.timestamp < TENANT_CONFIG_CACHE_TTL) {
    return cached.data;
  }

  const tenantWithDetails = await executeQuery(
    () => db.tenant.findUnique({
      where: { id: tenantId },
      include: { enabledStreamTypes: true },
    }),
    { maxRetries: 2, timeout: 10000 }
  );

  if (tenantWithDetails) {
    tenantConfigCache.set(tenantId, { 
      data: tenantWithDetails, 
      timestamp: Date.now() 
    });
  }

  return tenantWithDetails;
}

/**
 * Controller for creating a stream - OPTIMIZED
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

  try {
    // Tenant check
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!wallet || typeof wallet !== "string") {
      return res.status(400).json({ error: "Wallet address is required." });
    }

    if (!isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    // Get tenant configuration (cached)
    const tenantWithDetails = await getTenantConfig(tenant.id);

    if (!tenantWithDetails) {
      return res.status(404).json({ error: "Tenant configuration not found." });
    }

    // Define default enabled types
    const defaultEnabledTypes = {
      enableStream: true,
      enableMeeting: true,
      enablePodcast: false,
    };

    const effectiveEnabledTypes =
      tenantWithDetails.enabledStreamTypes || defaultEnabledTypes;

    // Determine stream session type
    let resolvedStreamSessionType: StreamSessionType;

    if (streamSessionType) {
      if (!Object.values(StreamSessionType).includes(streamSessionType as StreamSessionType)) {
        return res.status(400).json({
          error: "Invalid streamSessionType value",
          validTypes: Object.values(StreamSessionType),
        });
      }

      let isEnabled = false;
      switch (streamSessionType as StreamSessionType) {
        case StreamSessionType.Livestream:
          isEnabled = effectiveEnabledTypes.enableStream;
          break;
        case StreamSessionType.Meeting:
          isEnabled = effectiveEnabledTypes.enableMeeting;
          break;
        case StreamSessionType.Podcast:
          isEnabled = effectiveEnabledTypes.enablePodcast;
          break;
      }

      if (!isEnabled) {
        return res.status(403).json({
          error: `${streamSessionType} is not enabled for this tenant`,
          allowedTypes: getEnabledStreamTypes(tenantWithDetails, defaultEnabledTypes),
        });
      }

      resolvedStreamSessionType = streamSessionType as StreamSessionType;
    } else {
      resolvedStreamSessionType = tenantWithDetails.defaultStreamType;

      let isDefaultEnabled = false;
      switch (resolvedStreamSessionType) {
        case StreamSessionType.Livestream:
          isDefaultEnabled = effectiveEnabledTypes.enableStream;
          break;
        case StreamSessionType.Meeting:
          isDefaultEnabled = effectiveEnabledTypes.enableMeeting;
          break;
        case StreamSessionType.Podcast:
          isDefaultEnabled = effectiveEnabledTypes.enablePodcast;
          break;
      }

      if (!isDefaultEnabled) {
        if (effectiveEnabledTypes.enableStream) {
          resolvedStreamSessionType = StreamSessionType.Livestream;
        } else if (effectiveEnabledTypes.enableMeeting) {
          resolvedStreamSessionType = StreamSessionType.Meeting;
        } else if (effectiveEnabledTypes.enablePodcast) {
          resolvedStreamSessionType = StreamSessionType.Podcast;
        } else {
          return res.status(403).json({
            error: "No stream types are enabled for this tenant",
            defaultType: tenantWithDetails.defaultStreamType,
            enabledTypes: [],
          });
        }
      }
    }

    // Determine funding type
    let resolvedFundingType = fundingType || tenantWithDetails.defaultFundingType;

    // Validate call type
    let resolvedCallType: CallType;
    switch ((callType || "").toLowerCase()) {
      case "video":
        resolvedCallType = CallType.Video;
        break;
      case "audio":
        resolvedCallType = CallType.Audio;
        break;
      default:
        return res.status(400).json({
          error: "Invalid callType. Must be 'video' or 'audio'",
          allowedValues: Object.values(CallType),
        });
    }

    // Date validation
    if (scheduledFor && new Date(scheduledFor) < new Date()) {
      return res.status(400).json({ error: "Cannot schedule a stream in the past." });
    }

    // Use transaction for creating user and stream
    const result = await executeTransaction(async (tx) => {
      // Find or create user
      let user = await tx.user.findFirst({
        where: {
          walletAddress: wallet,
          tenantId: tenant.id,
        },
      });

      if (!user) {
        user = await tx.user.create({
          data: {
            walletAddress: wallet,
            tenantId: tenant.id,
          },
        });
      }

      // Generate unique stream name
      const streamName = await generateUniqueStreamName(tenant.id);

      // Create stream
      const stream = await tx.stream.create({
        data: {
          name: streamName,
          title,
          callType: resolvedCallType,
          creatorWallet: wallet,
          streamSessionType: resolvedStreamSessionType,
          fundingType: resolvedFundingType,
          isPublic: isPublic,
          scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
          tenantId: tenant.id,
          userId: user.id,
        },
      });

      return stream;
    });

    // Create LiveKit room (outside transaction)
    await roomService.createRoom({
      name: result.name,
      emptyTimeout: 300,
      maxParticipants: 100,
    });

    success = true;
    res.status(201).json(result);
  } catch (error) {
    console.error("Error creating stream:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

/**
 * Controller for creating access token for stream - OPTIMIZED
 */
export const createStreamToken = async (req: TenantRequest, res: Response) => {
  const { roomName, userName, wallet, avatarUrl } = req.body;
  const tenant = req.tenant;
  let success = false;

  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!roomName || !userName || !wallet || typeof wallet !== "string") {
      return res.status(400).json({
        error: "Missing required fields: room name, wallet, and user name",
      });
    }

    if (!isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    if (avatarUrl && typeof avatarUrl !== "string") {
      return res.status(400).json({ error: "Avatar URL must be a string." });
    }

    // Check cache for stream
    const cacheKey = `${tenant.id}:${roomName}`;
    let existingStream = null;
    const cached = streamCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < STREAM_CACHE_TTL) {
      existingStream = cached.data;
    } else {
      existingStream = await executeQuery(
        () => db.stream.findFirst({
          where: {
            name: roomName,
            tenantId: tenant.id,
          },
          include: { user: true },
        }),
        { maxRetries: 2, timeout: 10000 }
      );
      
      if (existingStream) {
        streamCache.set(cacheKey, { data: existingStream, timestamp: Date.now() });
      }
    }

    if (!existingStream) {
      return res.status(404).json({ error: "Stream not found" });
    }

    // Use transaction for user and participant operations
    const result = await executeTransaction(async (tx) => {
      let user = await tx.user.findFirst({
        where: {
          walletAddress: wallet,
          tenantId: tenant.id,
        },
      });

      if (!user) {
        user = await tx.user.create({
          data: {
            walletAddress: wallet,
            tenantId: tenant.id,
          },
        });
      }

      // Determine userType
      let userType: "host" | "co-host" | "guest";
      if (user.id === existingStream.userId) {
        userType = "host";
      } else if (existingStream.streamSessionType === StreamSessionType.Meeting) {
        userType = "co-host";
      } else {
        userType = "guest";
      }

      // Check access permissions
      if (!existingStream.isPublic && userType === "guest") {
        const hasPermission = false; // Implement your permission check
        if (!hasPermission) {
          throw new Error("This stream requires permission to join");
        }
      }

      // Guest join validation
      if (userType === "guest" && !existingStream.hasHost) {
        throw new Error("Cannot join: Waiting for host to join the room");
      }

      // Create/update participant
      const existingParticipant = await tx.participant.findFirst({
        where: {
          walletAddress: wallet,
          streamId: existingStream.id,
          tenantId: tenant.id,
        },
      });

      let participant;
      if (existingParticipant) {
        if (existingParticipant.leftAt) {
          participant = await tx.participant.update({
            where: { id: existingParticipant.id },
            data: {
              leftAt: null,
              userName,
              userType,
              ...(avatarUrl && { avatarUrl }),
            },
          });
        } else {
          participant = existingParticipant;
        }
      } else {
        participant = await tx.participant.create({
          data: {
            userName,
            walletAddress: wallet,
            userType,
            streamId: existingStream.id,
            tenantId: tenant.id,
            ...(avatarUrl && { avatarUrl }),
          },
        });
      }

      // Update stream status if host joins
      if (userType === "host") {
        await tx.stream.update({
          where: { id: existingStream.id },
          data: {
            hasHost: true,
            isLive: true,
            startedAt: existingStream.startedAt || new Date(),
          },
        });
        
        // Invalidate stream cache
        streamCache.delete(cacheKey);
      }

      return { participant, userType };
    });

    // Generate token
    const accessToken = new AccessToken(
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!,
      {
        identity: result.participant.id,
        ttl: "60m",
        metadata: JSON.stringify({
          userName,
          participantId: result.participant.id,
          userType: result.userType,
          walletAddress: wallet,
          ...(avatarUrl && { avatarUrl }),
        }),
      }
    );

    accessToken.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: result.userType === "host" || result.userType === "co-host",
      canSubscribe: true,
      canPublishData: true,
      roomRecord: result.userType === "host" || result.userType === "co-host",
    });

    const token = await accessToken.toJwt();
    
    success = true;
    res.status(200).json({ token, userType: result.userType });
  } catch (error: any) {
    console.error("Error creating token:", error);
    
    if (error.message?.includes("permission") || error.message?.includes("Waiting for host")) {
      return res.status(403).json({ error: error.message });
    }
    
    res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

/**
 * Controller for getting stream details - OPTIMIZED
 */
export const getStream = async (req: TenantRequest, res: Response) => {
  const { streamId } = req.params;
  const tenant = req.tenant;
  let success = false;

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

    const stream = await executeQuery(
      () => db.stream.findFirst({
        where: {
          name: streamId,
          tenantId: tenant.id,
        },
        include: {
          agenda: {
            include: {
              pollContent: true,
              quizContent: {
                include: { questions: true },
              },
              qaContent: true,
              customContent: true,
            },
          },
          participants: {
            select: {
              id: true,
              userName: true,
              walletAddress: true,
              userType: true,
              avatarUrl: true,
              joinedAt: true,
              leftAt: true,
              totalPoints: true,
            }
          },
        },
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    if (!stream) {
      return res.status(404).json({ error: "Stream not found." });
    }

    // Cache the result
    streamCache.set(cacheKey, { data: stream, timestamp: Date.now() });

    success = true;
    res.status(200).json(stream);
  } catch (error) {
    console.error("Error fetching stream:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

/**
 * Controller for recording stream - OPTIMIZED
 */
export const recordStream = async (req: TenantRequest, res: Response) => {
  const { roomName, wallet } = req.body;
  const tenant = req.tenant;
  let success = false;

  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!roomName || !wallet || typeof wallet !== "string") {
      return res.status(400).json({
        error: "Missing required fields: room name and wallet",
      });
    }

    if (!isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    // Get stream and verify permissions
    const [stream, user] = await Promise.all([
      executeQuery(
        () => db.stream.findFirst({
          where: {
            name: roomName,
            tenantId: tenant.id,
          },
          include: {
            user: true,
          },
        }),
        { maxRetries: 2, timeout: 10000 }
      ),
      executeQuery(
        () => db.user.findFirst({
          where: {
            walletAddress: wallet,
            tenantId: tenant.id,
          },
        }),
        { maxRetries: 2, timeout: 10000 }
      )
    ]);

    if (!stream) {
      return res.status(404).json({ error: "Stream not found." });
    }

    if (stream.recording) {
      return res.status(400).json({
        error: "Stream is already being recorded",
        recordId: stream.recordId,
      });
    }

    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    let userType: "host" | "co-host" | "guest";
    if (user.id === stream.userId) {
      userType = "host";
    } else if (stream.streamSessionType === StreamSessionType.Meeting) {
      userType = "co-host";
    } else {
      userType = "guest";
    }

    if (userType !== "host" && userType !== "co-host") {
      return res.status(403).json({
        error: "Only hosts and co-hosts can record streams.",
      });
    }

    // Start recording
    const egressService = new EgressClient(
      livekitHost,
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!
    );

    const output = {
      file: new EncodedFileOutput({
        filepath: `stream-${stream.id}-${Date.now()}.mp4`,
        output: {
          case: "aliOSS",
          value: {
            accessKey: process.env.ALIOSS_ACCESSKEY_ID,
            secret: process.env.ALIOSS_ACCESSKEY_SECRET,
            bucket: process.env.ALIOSS_BUCKET,
            endpoint: process.env.ALIOSS_ENDPOINT,
            region: process.env.ALIOSS_REGION,
          },
        },
      }),
      stream: new StreamOutput({
        protocol: StreamProtocol.RTMP,
        urls: [],
      }),
    };

    const egressInfo = await egressService.startRoomCompositeEgress(
      roomName,
      output
    );

    if (!egressInfo) {
      return res
        .status(500)
        .json({ error: "Failed to start recording. Please try again" });
    }

    await executeQuery(
      () => db.stream.update({
        where: { id: stream.id },
        data: {
          recording: true,
          recordId: egressInfo.egressId,
        },
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    // Invalidate cache
    streamCache.delete(`${tenant.id}:${roomName}`);

    success = true;
    res.status(201).json({
      message: "Recording started",
      recordingId: egressInfo.egressId,
      streamId: stream.id,
    });
  } catch (error) {
    console.error("Error starting recording:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error instanceof Error ? error.message : String(error),
    });
  } finally {
    trackQuery(success);
  }
};

/**
 * Controller for stopping stream recording - OPTIMIZED
 */
export const stopStreamRecord = async (req: TenantRequest, res: Response) => {
  const { recordId, wallet } = req.body;
  const tenant = req.tenant;
  let success = false;

  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!recordId || !wallet || typeof wallet !== "string") {
      return res.status(400).json({
        error: "Missing required fields: recordId and wallet",
      });
    }

    if (!isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    const [stream, user] = await Promise.all([
      executeQuery(
        () => db.stream.findFirst({
          where: {
            recordId,
            tenantId: tenant.id,
            recording: true,
          },
          include: {
            user: true,
          },
        }),
        { maxRetries: 2, timeout: 10000 }
      ),
      executeQuery(
        () => db.user.findFirst({
          where: {
            walletAddress: wallet,
            tenantId: tenant.id,
          },
        }),
        { maxRetries: 2, timeout: 10000 }
      )
    ]);

    if (!stream) {
      return res.status(404).json({ error: "Active recording not found" });
    }

    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    let userType: "host" | "co-host" | "guest";
    if (user.id === stream.userId) {
      userType = "host";
    } else if (stream.streamSessionType === StreamSessionType.Meeting) {
      userType = "co-host";
    } else {
      userType = "guest";
    }

    if (userType !== "host" && userType !== "co-host") {
      return res.status(403).json({
        error: "Only hosts and co-hosts can stop recordings.",
      });
    }

    const egressService = new EgressClient(
      livekitHost,
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!
    );

    await egressService.stopEgress(recordId);

    await executeQuery(
      () => db.stream.update({
        where: { id: stream.id },
        data: {
          recording: false,
        },
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    // Invalidate cache
    streamCache.delete(`${tenant.id}:${stream.name}`);

    success = true;
    res.status(200).json({
      message: "Recording stopped successfully",
      streamId: stream.id,
      recordId: recordId,
    });
  } catch (error) {
    console.error("Error stopping recording:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error instanceof Error ? error.message : String(error),
    });
  } finally {
    trackQuery(success);
  }
};

/**
 * Controller for updating stream - OPTIMIZED
 */
export const updateStream = async (req: TenantRequest, res: Response) => {
  const { streamId } = req.params;
  const {
    scheduledFor,
    title,
    callType,
    streamSessionType,
    fundingType,
    isPublic,
    wallet,
  } = req.body;
  const tenant = req.tenant;
  let success = false;

  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!streamId) {
      return res.status(400).json({ error: "Stream name is required." });
    }

    if (!wallet || typeof wallet !== "string") {
      return res.status(400).json({ error: "Valid wallet address is required." });
    }

    if (!isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    const [existingStream, requestingUser] = await Promise.all([
      executeQuery(
        () => db.stream.findFirst({
          where: {
            name: streamId,
            tenantId: tenant.id,
          },
          include: {
            user: true,
          },
        }),
        { maxRetries: 2, timeout: 10000 }
      ),
      executeQuery(
        () => db.user.findFirst({
          where: {
            walletAddress: wallet,
            tenantId: tenant.id,
          },
        }),
        { maxRetries: 2, timeout: 10000 }
      )
    ]);

    if (!existingStream) {
      return res.status(404).json({
        error: "Stream not found or access denied.",
        details: `Stream with name "${streamId}" not found`,
      });
    }

    if (!requestingUser) {
      return res.status(403).json({ error: "User not authorized." });
    }

    const isHost = requestingUser.id === existingStream.userId;
    const isCoHost = await executeQuery(
      () => db.participant.findFirst({
        where: {
          walletAddress: wallet,
          streamId: existingStream.id,
          userType: "co-host",
          tenantId: tenant.id,
          leftAt: null,
        },
      }),
      { maxRetries: 1, timeout: 5000 }
    );

    if (!isHost && !isCoHost) {
      return res.status(403).json({
        error: "Only hosts and co-hosts can update streams.",
      });
    }

    const isLive = existingStream.isLive;
    const updateData: any = {};

    if (title !== undefined) {
      if (typeof title !== "string" || title.trim().length === 0) {
        return res.status(400).json({ error: "Invalid title format." });
      }
      updateData.title = title.trim();
    }

    if (isPublic !== undefined) {
      updateData.isPublic = !!isPublic;
    }

    if (!isLive) {
      if (isHost) {
        if (streamSessionType !== undefined) {
          if (!Object.values(StreamSessionType).includes(streamSessionType as StreamSessionType)) {
            return res.status(400).json({
              error: "Invalid streamSessionType value",
              validTypes: Object.values(StreamSessionType),
            });
          }

          const tenantWithDetails = await getTenantConfig(tenant.id);

          if (!tenantWithDetails) {
            return res.status(400).json({ error: "Tenant configuration not found." });
          }

          const defaultEnabledTypes = {
            enableStream: true,
            enableMeeting: true,
            enablePodcast: false,
          };

          const effectiveEnabledTypes =
            tenantWithDetails.enabledStreamTypes || defaultEnabledTypes;

          let isEnabled = false;
          switch (streamSessionType as StreamSessionType) {
            case StreamSessionType.Livestream:
              isEnabled = effectiveEnabledTypes.enableStream;
              break;
            case StreamSessionType.Meeting:
              isEnabled = effectiveEnabledTypes.enableMeeting;
              break;
            case StreamSessionType.Podcast:
              isEnabled = effectiveEnabledTypes.enablePodcast;
              break;
          }

          if (!isEnabled) {
            const allowedTypes = [];
            if (effectiveEnabledTypes.enableStream) {
              allowedTypes.push(StreamSessionType.Livestream);
            }
            if (effectiveEnabledTypes.enableMeeting) {
              allowedTypes.push(StreamSessionType.Meeting);
            }
            if (effectiveEnabledTypes.enablePodcast) {
              allowedTypes.push(StreamSessionType.Podcast);
            }

            return res.status(403).json({
              error: `${streamSessionType} is not enabled for this tenant`,
              allowedTypes: allowedTypes,
            });
          }

          updateData.streamSessionType = streamSessionType;
        }

        if (fundingType !== undefined) {
          if (!Object.values(StreamFundingType).includes(fundingType)) {
            return res.status(400).json({
              error: "Invalid fundingType value.",
              validTypes: Object.values(StreamFundingType),
            });
          }
          updateData.fundingType = fundingType;
        }

        if (scheduledFor !== undefined) {
          updateData.scheduledFor = scheduledFor ? new Date(scheduledFor) : null;
        }
      }

      if (callType !== undefined) {
        if (!Object.values(CallType).includes(callType)) {
          return res.status(400).json({
            error: "Invalid callType value.",
            validTypes: Object.values(CallType),
          });
        }
        updateData.callType = callType;
      }
    } else if (
      scheduledFor !== undefined ||
      callType !== undefined ||
      streamSessionType !== undefined ||
      fundingType !== undefined
    ) {
      return res.status(400).json({
        error: "Cannot update scheduledFor, callType, streamSessionType, or fundingType after stream has started",
        currentStatus: "Stream is live",
      });
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No valid fields provided for update." });
    }

    const updatedStream = await executeQuery(
      () => db.stream.update({
        where: {
          id: existingStream.id,
        },
        data: updateData,
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    // Invalidate cache
    streamCache.delete(`${tenant.id}:${streamId}`);
    streamCache.delete(`${tenant.id}:${streamId}:full`);

    success = true;
    return res.status(200).json(updatedStream);
  } catch (error) {
    console.error("Error updating stream:", error);
    return res.status(500).json({
      error: "Internal server error",
    });
  } finally {
    trackQuery(success);
  }
};

/**
 * Controller for ending stream - OPTIMIZED
 */
export const endStream = async (req: TenantRequest, res: Response) => {
  const { streamId } = req.params;
  const { wallet } = req.body;
  const tenant = req.tenant;
  let success = false;

  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!streamId) {
      return res.status(400).json({ error: "Stream name is required." });
    }

    if (!wallet || typeof wallet !== "string") {
      return res.status(400).json({ error: "Valid wallet address is required." });
    }

    if (!isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    const [existingStream, requestingUser] = await Promise.all([
      executeQuery(
        () => db.stream.findFirst({
          where: {
            name: streamId,
            tenantId: tenant.id,
            isLive: true,
          },
          include: {
            user: true,
          },
        }),
        { maxRetries: 2, timeout: 10000 }
      ),
      executeQuery(
        () => db.user.findFirst({
          where: {
            walletAddress: wallet,
            tenantId: tenant.id,
          },
        }),
        { maxRetries: 2, timeout: 10000 }
      )
    ]);

    if (!existingStream) {
      return res.status(404).json({
        error: "Active stream not found",
        details: `Stream with name "${streamId}" not found or is not currently live`,
      });
    }

    if (!requestingUser) {
      return res.status(403).json({ error: "User not authorized." });
    }

    const isHost = requestingUser.id === existingStream.userId;
    if (!isHost) {
      return res.status(403).json({
        error: "Only the host can end this stream",
      });
    }

    if (existingStream.recording && existingStream.recordId) {
      try {
        const egressService = new EgressClient(
          livekitHost,
          process.env.LIVEKIT_API_KEY!,
          process.env.LIVEKIT_API_SECRET!
        );

        await egressService.stopEgress(existingStream.recordId);
      } catch (recordingError) {
        console.error("Error stopping recording:", recordingError);
      }
    }

    const endedStream = await executeQuery(
      () => db.stream.update({
        where: { id: existingStream.id },
        data: {
          isLive: false,
          endedAt: new Date(),
          recording: false,
        },
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    // Invalidate cache
    streamCache.delete(`${tenant.id}:${streamId}`);
    streamCache.delete(`${tenant.id}:${streamId}:full`);

    success = true;
    return res.status(200).json({
      message: "Stream ended successfully",
      streamId: endedStream.id,
      streamName: endedStream.name,
      duration:
        endedStream.startedAt && endedStream.endedAt
          ? Math.floor(
              (endedStream.endedAt.getTime() - endedStream.startedAt.getTime()) / 1000
            )
          : null,
    });
  } catch (error) {
    console.error("Error ending stream:", error);
    return res.status(500).json({
      error: "Internal server error",
    });
  } finally {
    trackQuery(success);
  }
};

/**
 * Controller for streaming to YouTube - OPTIMIZED
 */
export const streamToYoutube = async (req: TenantRequest, res: Response) => {
  const { roomName, wallet, youtubeRtmpUrl } = req.body;
  const tenant = req.tenant;
  let success = false;

  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!roomName || !wallet || typeof wallet !== "string" || !youtubeRtmpUrl) {
      return res.status(400).json({
        error: "Missing required fields: room name, wallet, or YouTube RTMP URL",
      });
    }

    if (!isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    if (!youtubeRtmpUrl.startsWith("rtmp://")) {
      return res.status(400).json({
        error: "Invalid YouTube RTMP URL format. Should start with rtmp://",
      });
    }

    const [stream, user] = await Promise.all([
      executeQuery(
        () => db.stream.findFirst({
          where: {
            name: roomName,
            tenantId: tenant.id,
          },
          include: {
            user: true,
          },
        }),
        { maxRetries: 2, timeout: 10000 }
      ),
      executeQuery(
        () => db.user.findFirst({
          where: {
            walletAddress: wallet,
            tenantId: tenant.id,
          },
        }),
        { maxRetries: 2, timeout: 10000 }
      )
    ]);

    if (!stream) {
      return res.status(404).json({ error: "Stream not found." });
    }

    if (stream.recording) {
      return res.status(400).json({
        error: "Stream is already being recorded or streamed",
        recordId: stream.recordId,
      });
    }

    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    let userType: "host" | "co-host" | "guest";
    if (user.id === stream.userId) {
      userType = "host";
    } else if (stream.streamSessionType === StreamSessionType.Meeting) {
      userType = "co-host";
    } else {
      userType = "guest";
    }

    if (userType !== "host") {
      return res.status(403).json({
        error: "Only the host can stream to YouTube.",
      });
    }

    const egressService = new EgressClient(
      livekitHost,
      process.env.LIVEKIT_API_KEY || "",
      process.env.LIVEKIT_API_SECRET || ""
    );

    const output = {
      stream: new StreamOutput({
        protocol: StreamProtocol.RTMP,
        urls: [youtubeRtmpUrl],
      }),
    };

    const egressInfo = await egressService.startRoomCompositeEgress(
      roomName,
      output
    );

    if (!egressInfo) {
      return res.status(500).json({ error: "Failed to start YouTube stream. Please try again" });
    }

    await executeQuery(
      () => db.stream.update({
        where: { id: stream.id },
        data: {
          recording: true,
          recordId: egressInfo.egressId,
        },
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    // Invalidate cache
    streamCache.delete(`${tenant.id}:${roomName}`);

    success = true;
    res.status(201).json({
      message: "YouTube streaming started",
      recordingId: egressInfo.egressId,
      streamId: stream.id,
    });
  } catch (error) {
    console.error("Error starting YouTube stream:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error instanceof Error ? error.message : String(error),
    });
  } finally {
    trackQuery(success);
  }
};

/**
 * Controller for stopping YouTube stream - OPTIMIZED
 */
export const stopYoutubeStream = async (req: TenantRequest, res: Response) => {
  const { recordId, wallet } = req.body;
  const tenant = req.tenant;
  let success = false;

  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!recordId || !wallet || typeof wallet !== "string") {
      return res.status(400).json({
        error: "Missing required fields: recordId and wallet",
      });
    }

    if (!isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    const [stream, user] = await Promise.all([
      executeQuery(
        () => db.stream.findFirst({
          where: {
            recordId,
            tenantId: tenant.id,
            recording: true,
          },
          include: {
            user: true,
          },
        }),
        { maxRetries: 2, timeout: 10000 }
      ),
      executeQuery(
        () => db.user.findFirst({
          where: {
            walletAddress: wallet,
            tenantId: tenant.id,
          },
        }),
        { maxRetries: 2, timeout: 10000 }
      )
    ]);

    if (!stream) {
      return res.status(404).json({ error: "Active streaming session not found" });
    }

    if (!user) {
      return res.status(403).json({ error: "User not found" });
    }

    let userType: "host" | "co-host" | "guest";
    if (user.id === stream.userId) {
      userType = "host";
    } else if (stream.streamSessionType === StreamSessionType.Meeting) {
      userType = "co-host";
    } else {
      userType = "guest";
    }

    if (userType !== "host") {
      return res.status(403).json({
        error: "Only the host can stop YouTube streaming.",
      });
    }

    const egressService = new EgressClient(
      livekitHost,
      process.env.LIVEKIT_API_KEY || "",
      process.env.LIVEKIT_API_SECRET || ""
    );

    await egressService.stopEgress(recordId);

    await executeQuery(
      () => db.stream.update({
        where: { id: stream.id },
        data: {
          recording: false,
        },
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    // Invalidate cache
    streamCache.delete(`${tenant.id}:${stream.name}`);

    success = true;
    res.status(200).json({
      message: "YouTube streaming stopped successfully",
      streamId: stream.id,
      recordId: recordId,
    });
  } catch (error) {
    console.error("Error stopping YouTube stream:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error instanceof Error ? error.message : String(error),
    });
  } finally {
    trackQuery(success);
  }
};

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  
  // Clean stream cache
  for (const [key, value] of streamCache.entries()) {
    if (now - value.timestamp > STREAM_CACHE_TTL) {
      streamCache.delete(key);
    }
  }
  
  // Clean tenant config cache
  for (const [key, value] of tenantConfigCache.entries()) {
    if (now - value.timestamp > TENANT_CONFIG_CACHE_TTL) {
      tenantConfigCache.delete(key);
    }
  }
}, 60000); // Clean every minute