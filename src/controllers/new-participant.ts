import { Response } from "express";
import { AccessToken } from "livekit-server-sdk";
import WebSocket from "ws";
import { db, executeQuery, trackQuery } from "../prisma.js";
import {
  isValidWalletAddress,
  roomService,
} from "../utils/index.js";
import { TenantRequest } from "../types/index.js";
import { clientsByRoom, clientsByIdentity } from "../websocket.js";
import { wss } from "../app.js";

// Cache for participant data
const participantCache = new Map<string, { data: any; timestamp: number }>();
const PARTICIPANT_CACHE_TTL = 30000; // 30 seconds

/**
 * OPTIMIZED: Get stream participants with pagination and caching
 */
export const getStreamParticipants = async (req: TenantRequest, res: Response) => {
  const { streamId } = req.params;
  const tenant = req.tenant;
  let success = false;
  
  // Add pagination parameters
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100); // Max 100
  const skip = (page - 1) * limit;
  
  try {
    if (!tenant || !streamId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check cache first
    const cacheKey = `${tenant.id}:${streamId}:participants:${page}:${limit}`;
    const cached = participantCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < PARTICIPANT_CACHE_TTL) {
      success = true;
      return res.status(200).json(cached.data);
    }

    // OPTIMIZED: Use parallel queries for count and data
    const [participants, totalCount] = await Promise.all([
      executeQuery(
        () => db.participant.findMany({
          where: {
            stream: {
              name: streamId,
              tenantId: tenant.id
            }
          },
          select: {
            id: true,
            userName: true,
            walletAddress: true,
            userType: true,
            avatarUrl: true,
            joinedAt: true,
            leftAt: true,
            totalPoints: true
          },
          take: limit,
          skip: skip,
          orderBy: {
            joinedAt: 'desc'
          }
        }),
        { maxRetries: 1, timeout: 2000 }
      ),
      executeQuery(
        () => db.participant.count({
          where: {
            stream: {
              name: streamId,
              tenantId: tenant.id
            }
          }
        }),
        { maxRetries: 1, timeout: 1000 }
      )
    ]);

    const result = {
      participants,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    };

    // Cache the result
    participantCache.set(cacheKey, { data: result, timestamp: Date.now() });

    success = true;
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("Error fetching participants:", error);
    
    if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
      return res.status(504).json({ 
        error: "Database query timeout",
        message: "The request took too long. Please try again."
      });
    }
    
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

/**
 * OPTIMIZED: Update participant permissions with reduced queries
 */
export const updateParticipantPermissions = async (
  req: TenantRequest,
  res: Response
) => {
  const { participantId, streamId, wallet, participantWallet, action } = req.body;
  const tenant = req.tenant;
  let success = false;

  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!participantId || !streamId || !wallet || !participantWallet || !action) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (action !== "promote" && action !== "demote") {
      return res.status(400).json({
        error: "Action must be either 'promote' or 'demote'",
      });
    }

    if (!isValidWalletAddress(wallet) || !isValidWalletAddress(participantWallet)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    // OPTIMIZED: Single query to get all needed data
    const streamWithParticipant = await executeQuery(
      () => db.stream.findFirst({
        where: {
          name: streamId,
          tenantId: tenant.id,
        },
        select: {
          id: true,
          userId: true,
          user: {
            select: {
              walletAddress: true
            }
          },
          participants: {
            where: {
              walletAddress: participantWallet
            },
            select: {
              id: true,
              userType: true,
              userName: true,
              walletAddress: true,
              avatarUrl: true
            },
            take: 1
          }
        }
      }),
      { maxRetries: 1, timeout: 2000 }
    );

    if (!streamWithParticipant) {
      return res.status(404).json({ error: `Stream with name ${streamId} not found` });
    }

    // Check if requesting user is host
    const isHost = streamWithParticipant.user?.walletAddress === wallet;
    if (!isHost) {
      return res.status(403).json({ error: "Only hosts can update participant permissions" });
    }

    const participant = streamWithParticipant.participants[0];
    if (!participant) {
      return res.status(404).json({ error: "Participant not found in this stream" });
    }

    const expectedCurrentRole = action === "promote" ? "guest" : "temp-host";
    const newRole = action === "promote" ? "temp-host" : "guest";

    if (participant.userType !== expectedCurrentRole) {
      return res.status(400).json({ error: `Participant is not a ${expectedCurrentRole}` });
    }

    // Update participant
    const updatedParticipant = await executeQuery(
      () => db.participant.update({
        where: { id: participant.id },
        data: { userType: newRole },
      }),
      { maxRetries: 1, timeout: 2000 }
    );

    // Update LiveKit permissions asynchronously
    setImmediate(async () => {
      try {
        const livekitParticipant = await roomService.getParticipant(
          streamId,
          participantId
        );

        if (livekitParticipant) {
          await roomService.updateParticipant(streamId, participantId, undefined, {
            canPublish: action === "promote",
            canSubscribe: true,
          });
        }
      } catch (error) {
        console.error("Error updating LiveKit permissions:", error);
      }
    });

    // Generate new token
    const newAccessToken = new AccessToken(
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!,
      {
        identity: participantId,
        ttl: "60m",
        metadata: JSON.stringify({
          userName: participant.userName,
          participantId: participant.id,
          userType: newRole,
          walletAddress: participant.walletAddress,
          ...(participant.avatarUrl && { avatarUrl: participant.avatarUrl }),
        }),
      }
    );

    newAccessToken.addGrant({
      roomJoin: true,
      room: streamId,
      canPublish: action === "promote",
      canSubscribe: true,
      canPublishData: true,
      roomRecord: false,
    });

    const token = await newAccessToken.toJwt();

    // Send WebSocket notifications asynchronously
    setImmediate(() => {
      if (wss && wss.clients) {
        const event = action === "promote" ? "inviteGuest" : "returnToGuest";

        if (clientsByRoom[streamId]) {
          const roomEventMessage = JSON.stringify({
            event: event,
            data: {
              participantId,
              roomName: streamId,
            },
          });

          clientsByRoom[streamId].forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(roomEventMessage);
            }
          });
        }

        if (clientsByIdentity[participantId]) {
          const tokenMessage = JSON.stringify({
            event: "newToken",
            data: { token, newUserType: newRole },
          });

          if (clientsByIdentity[participantId].readyState === WebSocket.OPEN) {
            clientsByIdentity[participantId].send(tokenMessage);
          }
        }
      }
    });

    // Invalidate cache
    participantCache.clear(); // Clear all participant cache for this stream

    const message = action === "promote"
      ? `Invited participant ${participantId} to speak`
      : `Revoked speaking permissions for participant ${participantId}`;

    success = true;
    return res.status(200).json({
      message,
      token,
      participantId,
      newRole: newRole,
    });
  } catch (error: any) {
    console.error(`Error ${action === "promote" ? "promoting" : "demoting"} participant:`, error);
    
    if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
      return res.status(504).json({ 
        error: "Database query timeout",
        message: "The operation took too long. Please try again."
      });
    }
    
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

/**
 * OPTIMIZED: Get participant scores with limited data
 */
export const getParticipantScores = async (
  req: TenantRequest,
  res: Response
) => {
  const { streamId } = req.params;
  const tenant = req.tenant;
  let success = false;

  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!streamId) {
      return res.status(400).json({ error: "Missing required field: streamId" });
    }

    // Get stream first
    const stream = await executeQuery(
      () => db.stream.findFirst({
        where: {
          name: streamId,
          tenantId: tenant.id,
        },
        select: {
          id: true,
          name: true,
        }
      }),
      { maxRetries: 1, timeout: 1500 }
    );

    if (!stream) {
      return res.status(404).json({ error: `Stream with name ${streamId} not found` });
    }

    // OPTIMIZED: Use aggregation for quiz response counts
    const participants = await executeQuery(
      () => db.participant.findMany({
        where: {
          streamId: stream.id,
          tenantId: tenant.id,
        },
        select: {
          id: true,
          userName: true,
          walletAddress: true,
          totalPoints: true,
          _count: {
            select: {
              quizResponses: true
            }
          },
          quizResponses: {
            where: {
              isCorrect: true
            },
            select: {
              id: true
            }
          }
        },
        orderBy: {
          totalPoints: "desc",
        },
        take: 50 // Limit to top 50 participants
      }),
      { maxRetries: 1, timeout: 2500 }
    );

    // Format the response
    const leaderboard = participants.map((participant) => {
      const correctAnswers = participant.quizResponses.length;
      const totalAnswers = participant._count.quizResponses;

      return {
        participantId: participant.id,
        userName: participant.userName,
        walletAddress: participant.walletAddress,
        totalPoints: participant.totalPoints,
        correctAnswers,
        totalAnswers,
        accuracy: totalAnswers > 0
          ? Math.round((correctAnswers / totalAnswers) * 100)
          : 0,
      };
    });

    success = true;
    return res.status(200).json({
      stream: {
        id: stream.id,
        name: stream.name,
      },
      leaderboard,
    });
  } catch (error: any) {
    console.error("Error fetching participant scores:", error);
    
    if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
      return res.status(504).json({ 
        error: "Database query timeout",
        message: "The request took too long. Please try again."
      });
    }

    return res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

/**
 * Update participant left time
 */
export const updateParticipantLeftTime = async (
  req: TenantRequest,
  res: Response
) => {
  const { streamId } = req.params;
  const { wallet, leftAt } = req.body;
  const tenant = req.tenant;
  let success = false;

  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!streamId || !wallet) {
      return res.status(400).json({ error: "Missing required fields: streamId, wallet" });
    }

    if (!isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    // Update all matching participants
    const updateResult = await executeQuery(
      () => db.participant.updateMany({
        where: {
          stream: {
            name: streamId,
            tenantId: tenant.id
          },
          walletAddress: wallet,
          leftAt: null // Only update those not already marked as left
        },
        data: { 
          leftAt: new Date(leftAt || Date.now())
        },
      }),
      { maxRetries: 1, timeout: 2000 }
    );

    if (updateResult.count === 0) {
      return res.status(404).json({ error: "No active participant found" });
    }

    // Invalidate cache
    participantCache.clear();

    success = true;
    return res.status(200).json({ 
      message: `${updateResult.count} participants updated successfully`
    });
  } catch (error: any) {
    console.error("Error updating participant left time:", error);
    
    if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
      return res.status(504).json({ 
        error: "Database query timeout",
        message: "The operation took too long. Please try again."
      });
    }
    
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of participantCache.entries()) {
    if (now - value.timestamp > PARTICIPANT_CACHE_TTL) {
      participantCache.delete(key);
    }
  }
}, 60000); // Clean every minute