import { Response } from "express";
import { AccessToken } from "livekit-server-sdk";
import WebSocket from "ws";
import { db } from "../prisma.js";
import {
  isValidWalletAddress,
  roomService,
  getAvatarForUser,
} from "../utils/index.js";
import { TenantRequest } from "../types/index.js";
import { clientsByRoom, clientsByIdentity } from "../websocket.js";
import { ParticipantManager } from "../services/participantManager.js";
import { wss } from "../app.js";

/**
 * Controller for getting all stream participants
 */
export const getStreamParticipants = async (
  req: TenantRequest,
  res: Response
) => {
  const { streamId } = req.params;
  const tenant = req.tenant;

  try {
    // 1. Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    // 2. Input validation
    if (!streamId) {
      return res
        .status(400)
        .json({ error: "Missing required field: streamId" });
    }

    // 3. Find the stream and its participants
    const stream = await db.stream.findFirst({
      where: {
        name: streamId,
        tenantId: tenant.id,
      },
      include: { participants: true },
    });

    if (!stream) {
      return res.status(404).json({
        error: `Stream with name ${streamId} not found`,
      });
    }

    // 4. Return participants
    res.status(200).json({ participants: stream.participants });
  } catch (error) {
    console.error("Error fetching stream participants:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await db.$disconnect();
  }
};

/**
 * Controller for updating participant's leftAt time when they leave a stream
 */


/**
 * Controller for updating participant permissions (promote guest to temp-host or demote temp-host to guest)
 */
export const updateParticipantPermissions = async (
  req: TenantRequest,
  res: Response
) => {
  const { participantId, streamId, wallet, participantWallet, action } =
    req.body;
  const tenant = req.tenant;

  try {
    // 1. Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    // 2. Input validation
    if (
      !participantId ||
      !streamId ||
      !wallet ||
      !participantWallet ||
      !action
    ) {
      return res.status(400).json({
        error:
          "Missing required fields: participantId, streamId, wallet, participantWallet, or action",
      });
    }

    if (action !== "promote" && action !== "demote") {
      return res.status(400).json({
        error: "Action must be either 'promote' or 'demote'",
      });
    }

    if (
      !isValidWalletAddress(wallet) ||
      !isValidWalletAddress(participantWallet)
    ) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    // 3. Find the stream
    const stream = await db.stream.findFirst({
      where: {
        name: streamId,
        tenantId: tenant.id,
      },
    });

    if (!stream) {
      return res
        .status(404)
        .json({ error: `Stream with name ${streamId} not found` });
    }

    // 4. Verify the requesting user is a host
    const requestingUser = await db.user.findFirst({
      where: {
        walletAddress: wallet,
        tenantId: tenant.id,
      },
    });

    if (!requestingUser) {
      return res.status(403).json({ error: "User not authorized." });
    }

    const isHost = requestingUser.id === stream.userId;
    if (!isHost) {
      return res
        .status(403)
        .json({ error: "Only hosts can update participant permissions" });
    }

    // 5. Find the participant by wallet address
    const participant = await db.participant.findFirst({
      where: {
        streamId: stream.id,
        walletAddress: participantWallet,
        tenantId: tenant.id,
      },
    });

    if (!participant) {
      return res.status(404).json({
        error: "Participant not found in this stream",
        details: {
          streamId,
          participantWallet,
        },
      });
    }

    // 6. Check if the participant has the expected current role
    const expectedCurrentRole = action === "promote" ? "guest" : "temp-host";
    const newRole = action === "promote" ? "temp-host" : "guest";

    if (participant.userType !== expectedCurrentRole) {
      return res.status(400).json({
        error: `Participant is not a ${expectedCurrentRole}`,
        currentRole: participant.userType,
      });
    }

    // 7. Update the participant's role in the database
    await db.participant.update({
      where: { id: participant.id },
      data: { userType: newRole },
    });

    // 8. Update LiveKit permissions
    const avatarUrl = getAvatarForUser(participant.id);
    try {
      const livekitParticipant = await roomService.getParticipant(
        streamId,
        participantId
      );

      if (!livekitParticipant) {
        console.error("LiveKit Participant not found:", participantId);
        return res.status(404).json({ error: "LiveKit participant not found" });
      }

      await roomService.updateParticipant(streamId, participantId, undefined, {
        canPublish: action === "promote",
        canSubscribe: true,
      });

      // 9. Generate a new token with updated permissions
      const newAccessToken = new AccessToken(
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET,
        {
          identity: participantId,
          ttl: "60m",
          metadata: JSON.stringify({
            userName: participant.userName,
            participantId: participant.id,
            userType: newRole,
            avatarUrl,
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

      // 10. Send WebSocket notifications
      if (wss && wss.clients) {
        // Send event to all clients in the room
        const event = action === "promote" ? "inviteGuest" : "returnToGuest";

        // Broadcasting room event through WebSocket
        if (clientsByRoom[streamId]) {
          const roomEventMessage = JSON.stringify({
            event: event,
            data: {
              participantId,
              roomName: streamId,
            },
          });

          console.log(
            `Broadcasting ${event} message to all clients in room ${streamId}`
          );

          clientsByRoom[streamId].forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(roomEventMessage);
            }
          });
        }

        // Send token specifically to the participant
        if (clientsByIdentity[participantId]) {
          const tokenMessage = JSON.stringify({
            event: "newToken",
            data: { token },
          });

          console.log(
            `Sending newToken message to participant ${participantId}`
          );

          if (clientsByIdentity[participantId].readyState === WebSocket.OPEN) {
            clientsByIdentity[participantId].send(tokenMessage);
          }
        } else {
          console.warn(
            `Participant ${participantId} not found in connected clients`
          );
        }
      }

      const message =
        action === "promote"
          ? `Invited participant ${participantId} to speak`
          : `Revoked speaking permissions for participant ${participantId}`;

      res.status(200).json({
        message,
        token,
        participantId,
        newRole,
      });
    } catch (error) {
      console.error("Error updating LiveKit permissions:", error);
      res
        .status(500)
        .json({ error: "Failed to update participant permissions in LiveKit" });
    }
  } catch (error) {
    console.error(
      `Error ${action === "promote" ? "promoting" : "demoting"} participant:`,
      error
    );
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await db.$disconnect();
  }
};
/**
 * Controller for getting participant quiz scores and stats
 */
export const getParticipantScores = async (
  req: TenantRequest,
  res: Response
) => {
  const { streamId } = req.params;
  const tenant = req.tenant;

  try {
    // 1. Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    // 2. Input validation
    if (!streamId) {
      return res
        .status(400)
        .json({ error: "Missing required field: streamId" });
    }

    // 3. Find the stream
    const stream = await db.stream.findFirst({
      where: {
        name: streamId,
        tenantId: tenant.id,
      },
    });

    if (!stream) {
      return res
        .status(404)
        .json({ error: `Stream with name ${streamId} not found` });
    }

    // 4. Get participants with quiz responses
    const participants = await db.participant.findMany({
      where: {
        streamId: stream.id,
        tenantId: tenant.id,
      },
      include: {
        quizResponses: {
          include: {
            question: true,
          },
        },
      },
      orderBy: {
        totalPoints: "desc",
      },
    });

    // 5. Format the response
    const leaderboard = participants.map((participant) => {
      const correctAnswers = participant.quizResponses.filter(
        (r) => r.isCorrect
      ).length;
      const totalAnswers = participant.quizResponses.length;

      return {
        participantId: participant.id,
        userName: participant.userName,
        walletAddress: participant.walletAddress,
        totalPoints: participant.totalPoints,
        correctAnswers,
        totalAnswers,
        accuracy:
          totalAnswers > 0
            ? Math.round((correctAnswers / totalAnswers) * 100)
            : 0,
      };
    });

    res.status(200).json({
      stream: {
        id: stream.id,
        name: stream.name,
      },
      leaderboard,
    });
  } catch (error) {
    console.error("Error fetching participant scores:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await db.$disconnect();
  }
};

/**
 * Controller for handling WebSocket disconnections and updating participant data
 */


/**
 * Controller for updating participant's leftAt time when they leave a stream
 */
export const updateParticipantLeftTime = async (
  req: TenantRequest,
  res: Response
) => {
  const { streamId } = req.params;
  // const { wallet, leftAt } = req.body;

  let wallet, leftAt;
  
  // Handle both JSON body and FormData from sendBeacon
  if (req.method === 'POST' && req.query.method === 'PUT') {
    // This is a sendBeacon request which comes as FormData
    wallet = req.body.wallet;
    leftAt = req.body.leftAt;
  } else {
    // Regular JSON body
    ({ wallet, leftAt } = req.body);
  }
  
  const tenant = req.tenant;

  try {
    // 1. Log everything for debugging
    console.log(`updateParticipantLeftTime called:`, { 
      streamId, 
      wallet, 
      leftAt, 
      tenantId: tenant?.id 
    });

    // 2. Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    // 3. Input validation
    if (!streamId || !wallet) {
      return res
        .status(400)
        .json({ error: "Missing required fields: streamId, wallet" });
    }

    if (!isValidWalletAddress(wallet)) {
      console.log(`Invalid wallet address: ${wallet}`);
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    // 4. Find the stream
    const stream = await db.stream.findFirst({
      where: {
        name: streamId,
        tenantId: tenant.id,
      },
    });

    if (!stream) {
      console.log(`Stream not found: ${streamId}`);
      return res.status(404).json({ error: `Stream not found` });
    }

    // 5. Find ALL participants for this wallet (there might be duplicates)
    console.log(`Looking for participant with wallet ${wallet} in stream ${streamId}`);
    
    const participants = await db.participant.findMany({
      where: {
        streamId: stream.id,
        walletAddress: wallet,
        tenantId: tenant.id,
      },
    });

    if (participants.length === 0) {
      console.log(`No participants found for wallet ${wallet}`);
      return res.status(404).json({ error: "Participant not found" });
    }

    // 6. Count updates
    let updateCount = 0;

    // 7. Update ALL matching participants (to handle potential duplicates)
    for (const participant of participants) {
      if (!participant.leftAt) {
        try {
          await db.participant.update({
            where: { id: participant.id },
            data: { leftAt: new Date(leftAt || Date.now()) },
          });
          updateCount++;
          console.log(`Updated leftAt for participant ${participant.id}`);
        } catch (error) {
          console.error(`Failed to update participant ${participant.id}:`, error);
        }
      } else {
        console.log(`Participant ${participant.id} already marked as left`);
      }
    }

    // 8. Return success
    return res.status(200).json({ 
      message: `${updateCount} participants updated successfully`,
      updatedIds: participants.map(p => p.id)
    });
  } catch (error) {
    console.error("Error updating participant left time:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await db.$disconnect();
  }
};

// Update the handleWebSocketDisconnect function
export const handleWebSocketDisconnect = async (
  req: TenantRequest,
  res: Response
) => {
  const { streamId, participantId } = req.params;
  const tenant = req.tenant;

  try {
    // 1. Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    // 2. Input validation
    if (!streamId || !participantId) {
      return res
        .status(400)
        .json({ error: "Missing required fields: streamId, participantId" });
    }

    // 3. Use the centralized service to mark participant as left
    const dbSuccess = await ParticipantManager.markParticipantAsLeft(streamId, null, participantId);
    
    // 4. Clean up WebSocket state
    const wsSuccess = ParticipantManager.cleanupWebSocketState(streamId, participantId);

    if (!dbSuccess && !wsSuccess) {
      return res.status(404).json({ error: "Participant not found" });
    }

    res.status(200).json({ message: "Participant disconnect handled successfully" });
  } catch (error) {
    console.error("Error handling WebSocket disconnect:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await db.$disconnect();
  }
};