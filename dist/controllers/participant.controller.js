import { AccessToken } from "livekit-server-sdk";
import WebSocket from "ws";
import { db, executeQuery, trackQuery } from "../prisma.js";
import { isValidWalletAddress, roomService, } from "../utils/index.js";
import { clientsByRoom, clientsByIdentity } from "../websocket.js";
import { ParticipantManager } from "../services/participantManager.js";
import { wss } from "../app.js";
// Cache for participant data
const participantCache = new Map();
const PARTICIPANT_CACHE_TTL = 30000; // 30 seconds
/**
 * Controller for getting all stream participants - FIXED
 */
// export const getStreamParticipants = async (
//   req: TenantRequest,
//   res: Response
// ) => {
//   const { streamId } = req.params;
//   const tenant = req.tenant;
//   let success = false;
//   try {
//     if (!tenant) {
//       return res.status(401).json({ error: "Tenant authentication required." });
//     }
//     if (!streamId) {
//       return res.status(400).json({ error: "Missing required field: streamId" });
//     }
//     // Check cache first
//     const cacheKey = `${tenant.id}:${streamId}:participants`;
//     const cached = participantCache.get(cacheKey);
//     if (cached && Date.now() - cached.timestamp < PARTICIPANT_CACHE_TTL) {
//       success = true;
//       return res.status(200).json({ participants: cached.data });
//     }
//     // Query with reduced timeout and limit
//     const stream = await executeQuery(
//       () => db.stream.findFirst({
//         where: {
//           name: streamId,
//           tenantId: tenant.id,
//         },
//         select: {
//           id: true,
//           participants: {
//             select: {
//               id: true,
//               userName: true,
//               walletAddress: true,
//               userType: true,
//               avatarUrl: true,
//               joinedAt: true,
//               leftAt: true,
//               totalPoints: true,
//             },
//             orderBy: {
//               joinedAt: 'desc'
//             },
//             take: 100 // Limit to prevent timeout
//           }
//         }
//       }),
//       { maxRetries: 1, timeout: 5000 } // Reduced timeout
//     );
//     if (!stream) {
//       return res.status(404).json({
//         error: `Stream with name ${streamId} not found`,
//       });
//     }
//     // Cache the results
//     participantCache.set(cacheKey, { 
//       data: stream.participants, 
//       timestamp: Date.now() 
//     });
//     success = true;
//     res.status(200).json({ participants: stream.participants });
//   } catch (error: any) {
//     console.error("Error fetching stream participants:", error);
//     if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
//       return res.status(504).json({ 
//         error: "Database query timeout",
//         message: "The request took too long. Please try again."
//       });
//     }
//     res.status(500).json({ error: "Internal server error" });
//   } finally {
//     trackQuery(success);
//   }
// };
/**
 * Controller for getting all stream participants - FIXED WITH RESPONSE CHECK
 */
export const getStreamParticipants = async (req, res) => {
    console.log('[DEBUG] getStreamParticipants V2 - WITH HEADER CHECKS');
    const { streamId } = req.params;
    const tenant = req.tenant;
    let success = false;
    try {
        // CRITICAL: Check if response already sent
        if (res.headersSent) {
            console.log(`[getStreamParticipants] Response already sent for ${streamId}`);
            return;
        }
        if (!tenant) {
            if (!res.headersSent) {
                return res.status(401).json({ error: "Tenant authentication required." });
            }
            return;
        }
        if (!streamId) {
            if (!res.headersSent) {
                return res.status(400).json({ error: "Missing required field: streamId" });
            }
            return;
        }
        // Check cache first
        const cacheKey = `${tenant.id}:${streamId}:participants`;
        const cached = participantCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < PARTICIPANT_CACHE_TTL) {
            success = true;
            if (!res.headersSent) {
                return res.status(200).json({ participants: cached.data });
            }
            return;
        }
        // Create abort controller for timeout
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4500); // Slightly less than request timeout
        try {
            // Query with abort signal
            const stream = await executeQuery(() => db.stream.findFirst({
                where: {
                    name: streamId,
                    tenantId: tenant.id,
                },
                select: {
                    id: true,
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
                        },
                        orderBy: {
                            joinedAt: 'desc'
                        },
                        take: 100 // Limit to prevent timeout
                    }
                }
            }), { maxRetries: 1, timeout: 4000 } // Reduced timeout
            );
            clearTimeout(timeout);
            // Check again before sending response
            if (res.headersSent) {
                console.log(`[getStreamParticipants] Response sent while querying for ${streamId}`);
                return;
            }
            if (!stream) {
                if (!res.headersSent) {
                    return res.status(404).json({
                        error: `Stream with name ${streamId} not found`,
                    });
                }
                return;
            }
            // Cache the results
            participantCache.set(cacheKey, {
                data: stream.participants,
                timestamp: Date.now()
            });
            success = true;
            // Final check before sending
            if (!res.headersSent) {
                res.status(200).json({ participants: stream.participants });
            }
        }
        catch (error) {
            clearTimeout(timeout);
            // Check if aborted
            if (controller.signal.aborted || error.name === 'AbortError') {
                console.log(`[getStreamParticipants] Query aborted for ${streamId} - timeout approaching`);
                if (!res.headersSent) {
                    return res.status(504).json({
                        error: "Request timeout - query took too long",
                        message: "Please try again"
                    });
                }
                return;
            }
            throw error; // Re-throw for outer catch
        }
    }
    catch (error) {
        console.error("Error fetching stream participants:", error);
        // Check before sending error response
        if (res.headersSent) {
            console.log(`[getStreamParticipants] Error after response sent for ${req.params.streamId}`);
            return;
        }
        if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
            return res.status(504).json({
                error: "Database query timeout",
                message: "The request took too long. Please try again."
            });
        }
        res.status(500).json({ error: "Internal server error" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for updating participant permissions - FIXED
 */
export const updateParticipantPermissions = async (req, res) => {
    const { participantId, streamId, wallet, participantWallet, action } = req.body;
    const tenant = req.tenant;
    let success = false;
    try {
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!participantId || !streamId || !wallet || !participantWallet || !action) {
            return res.status(400).json({
                error: "Missing required fields",
            });
        }
        if (action !== "promote" && action !== "demote") {
            return res.status(400).json({
                error: "Action must be either 'promote' or 'demote'",
            });
        }
        if (!isValidWalletAddress(wallet) || !isValidWalletAddress(participantWallet)) {
            return res.status(400).json({ error: "Invalid wallet address format." });
        }
        // Parallel fetch with reduced timeout
        const [stream, requestingUser] = await Promise.all([
            executeQuery(() => db.stream.findFirst({
                where: {
                    name: streamId,
                    tenantId: tenant.id,
                },
                select: {
                    id: true,
                    userId: true,
                }
            }), { maxRetries: 1, timeout: 3000 }),
            executeQuery(() => db.user.findFirst({
                where: {
                    walletAddress: wallet,
                    tenantId: tenant.id,
                },
                select: {
                    id: true
                }
            }), { maxRetries: 1, timeout: 3000 })
        ]);
        if (!stream) {
            return res.status(404).json({ error: `Stream with name ${streamId} not found` });
        }
        if (!requestingUser) {
            return res.status(403).json({ error: "User not authorized." });
        }
        const isHost = requestingUser.id === stream.userId;
        if (!isHost) {
            return res.status(403).json({ error: "Only hosts can update participant permissions" });
        }
        // Get participant
        const participant = await executeQuery(() => db.participant.findFirst({
            where: {
                streamId: stream.id,
                walletAddress: participantWallet,
                tenantId: tenant.id,
            },
        }), { maxRetries: 1, timeout: 3000 });
        if (!participant) {
            return res.status(404).json({ error: "Participant not found in this stream" });
        }
        const expectedCurrentRole = action === "promote" ? "guest" : "temp-host";
        const newRole = action === "promote" ? "temp-host" : "guest";
        if (participant.userType !== expectedCurrentRole) {
            return res.status(400).json({ error: `Participant is not a ${expectedCurrentRole}` });
        }
        // Update participant (single atomic operation)
        const updatedParticipant = await executeQuery(() => db.participant.update({
            where: { id: participant.id },
            data: {
                userType: newRole,
                version: { increment: 1 }
            },
        }), { maxRetries: 1, timeout: 3000 });
        // Update LiveKit permissions (can fail without breaking DB state)
        try {
            const livekitParticipant = await roomService.getParticipant(streamId, participantId);
            if (livekitParticipant) {
                await roomService.updateParticipant(streamId, participantId, undefined, {
                    canPublish: action === "promote",
                    canSubscribe: true,
                });
            }
            // Generate new token
            const newAccessToken = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
                identity: participantId,
                ttl: "60m",
                metadata: JSON.stringify({
                    userName: updatedParticipant.userName,
                    participantId: updatedParticipant.id,
                    userType: newRole,
                    walletAddress: updatedParticipant.walletAddress,
                    ...(updatedParticipant.avatarUrl && { avatarUrl: updatedParticipant.avatarUrl }),
                }),
            });
            newAccessToken.addGrant({
                roomJoin: true,
                room: streamId,
                canPublish: action === "promote",
                canSubscribe: true,
                canPublishData: true,
                roomRecord: false,
            });
            const token = await newAccessToken.toJwt();
            // Send WebSocket notifications (fire and forget)
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
            // Invalidate cache
            participantCache.delete(`${tenant.id}:${streamId}:participants`);
            const message = action === "promote"
                ? `Invited participant ${participantId} to speak`
                : `Revoked speaking permissions for participant ${participantId}`;
            success = true;
            res.status(200).json({
                message,
                token,
                participantId,
                newRole: newRole,
            });
        }
        catch (error) {
            console.error("Error updating LiveKit permissions:", error);
            // Still return success since DB update worked
            success = true;
            res.status(200).json({
                message: "Participant updated but LiveKit sync failed",
                participantId,
                newRole: newRole,
                warning: "LiveKit permissions may be out of sync"
            });
        }
    }
    catch (error) {
        console.error(`Error ${action === "promote" ? "promoting" : "demoting"} participant:`, error);
        if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
            return res.status(504).json({
                error: "Database query timeout",
                message: "The operation took too long. Please try again."
            });
        }
        if (error.message?.includes("not found") || error.message?.includes("not a")) {
            return res.status(400).json({ error: error.message });
        }
        res.status(500).json({ error: "Internal server error" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for getting participant quiz scores - FIXED
 */
export const getParticipantScores = async (req, res) => {
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
        // Get stream first with reduced timeout
        const stream = await executeQuery(() => db.stream.findFirst({
            where: {
                name: streamId,
                tenantId: tenant.id,
            },
            select: {
                id: true,
                name: true,
            }
        }), { maxRetries: 1, timeout: 3000 });
        if (!stream) {
            return res.status(404).json({ error: `Stream with name ${streamId} not found` });
        }
        // Get participants with quiz responses - limited results
        const participants = await executeQuery(() => db.participant.findMany({
            where: {
                streamId: stream.id,
                tenantId: tenant.id,
            },
            include: {
                quizResponses: {
                    select: {
                        isCorrect: true,
                        pointsEarned: true,
                    }
                },
            },
            orderBy: {
                totalPoints: "desc",
            },
            take: 50 // Limit to top 50 participants
        }), { maxRetries: 1, timeout: 5000 });
        // Format the response
        const leaderboard = participants.map((participant) => {
            const correctAnswers = participant.quizResponses.filter(r => r.isCorrect).length;
            const totalAnswers = participant.quizResponses.length;
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
        res.status(200).json({
            stream: {
                id: stream.id,
                name: stream.name,
            },
            leaderboard,
        });
    }
    catch (error) {
        console.error("Error fetching participant scores:", error);
        if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
            return res.status(504).json({
                error: "Database query timeout",
                message: "The request took too long. Please try again."
            });
        }
        res.status(500).json({ error: "Internal server error" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for updating participant left time - FIXED
 */
export const updateParticipantLeftTime = async (req, res) => {
    const { streamId } = req.params;
    let wallet, leftAt;
    // Handle both JSON body and FormData from sendBeacon
    if (req.method === 'POST' && req.query.method === 'PUT') {
        wallet = req.body.wallet;
        leftAt = req.body.leftAt;
    }
    else {
        ({ wallet, leftAt } = req.body);
    }
    const tenant = req.tenant;
    let success = false;
    try {
        console.log(`updateParticipantLeftTime called:`, {
            streamId,
            wallet,
            leftAt,
            tenantId: tenant?.id
        });
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!streamId || !wallet) {
            return res.status(400).json({ error: "Missing required fields: streamId, wallet" });
        }
        if (!isValidWalletAddress(wallet)) {
            console.log(`Invalid wallet address: ${wallet}`);
            return res.status(400).json({ error: "Invalid wallet address format." });
        }
        // Get stream with reduced timeout
        const stream = await executeQuery(() => db.stream.findFirst({
            where: {
                name: streamId,
                tenantId: tenant.id,
            },
            select: {
                id: true
            }
        }), { maxRetries: 1, timeout: 2000 });
        if (!stream) {
            console.log(`Stream not found: ${streamId}`);
            return res.status(404).json({ error: `Stream not found` });
        }
        // Update all matching participants (single operation)
        const updateResult = await executeQuery(() => db.participant.updateMany({
            where: {
                streamId: stream.id,
                walletAddress: wallet,
                tenantId: tenant.id,
                leftAt: null // Only update those not already marked as left
            },
            data: {
                leftAt: new Date(leftAt || Date.now()),
                version: { increment: 1 }
            },
        }), { maxRetries: 1, timeout: 3000 });
        if (updateResult.count === 0) {
            console.log(`No active participants found for wallet ${wallet}`);
            return res.status(404).json({ error: "No active participant found" });
        }
        // Invalidate cache
        participantCache.delete(`${tenant.id}:${streamId}:participants`);
        console.log(`Updated ${updateResult.count} participants for wallet ${wallet}`);
        success = true;
        return res.status(200).json({
            message: `${updateResult.count} participants updated successfully`
        });
    }
    catch (error) {
        console.error("Error updating participant left time:", error);
        if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
            return res.status(504).json({
                error: "Database query timeout",
                message: "The operation took too long. Please try again."
            });
        }
        res.status(500).json({ error: "Internal server error" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for handling WebSocket disconnect - FIXED
 */
export const handleWebSocketDisconnect = async (req, res) => {
    const { streamId, participantId } = req.params;
    const tenant = req.tenant;
    let success = false;
    try {
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!streamId || !participantId) {
            return res.status(400).json({ error: "Missing required fields: streamId, participantId" });
        }
        // Use the centralized service with timeout handling
        const [dbSuccess, wsSuccess] = await Promise.all([
            Promise.race([
                ParticipantManager.markParticipantAsLeft(streamId, null, participantId),
                new Promise((resolve) => setTimeout(() => resolve(false), 3000))
            ]),
            Promise.resolve(ParticipantManager.cleanupWebSocketState(streamId, participantId))
        ]);
        if (!dbSuccess && !wsSuccess) {
            return res.status(404).json({ error: "Participant not found" });
        }
        // Invalidate cache
        participantCache.delete(`${tenant.id}:${streamId}:participants`);
        success = true;
        res.status(200).json({ message: "Participant disconnect handled successfully" });
    }
    catch (error) {
        console.error("Error handling WebSocket disconnect:", error);
        if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
            return res.status(504).json({
                error: "Database query timeout",
                message: "The operation took too long. Please try again."
            });
        }
        res.status(500).json({ error: "Internal server error" });
    }
    finally {
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
