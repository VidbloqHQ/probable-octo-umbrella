import { AccessToken } from "livekit-server-sdk";
import WebSocket from "ws";
import { db } from "../prisma.js";
import { isValidWalletAddress, roomService } from "../utils/index.js";
import { clientsByRoom, clientsByIdentity } from "../websocket.js";
import { wss } from "../app.js";
/**
 * Controller for getting all stream participants
 */
export const getStreamParticipants = async (req, res) => {
    const { streamId } = req.params;
    const tenant = req.tenant;
    try {
        // 1. Tenant verification
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // 2. Input validation
        if (!streamId) {
            return res.status(400).json({ error: "Missing required field: streamId" });
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
    }
    catch (error) {
        console.error("Error fetching stream participants:", error);
        res.status(500).json({ error: "Internal server error" });
    }
    finally {
        await db.$disconnect();
    }
};
/**
 * Controller for updating participant's leftAt time when they leave a stream
 */
export const updateParticipantLeftTime = async (req, res) => {
    const { streamId } = req.params;
    const { wallet, leftAt } = req.body;
    const tenant = req.tenant;
    try {
        // 1. Tenant verification
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // 2. Input validation
        if (!streamId || !wallet || !leftAt) {
            return res.status(400).json({ error: "Missing required fields: streamId, wallet, leftAt" });
        }
        if (!isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Invalid wallet address format." });
        }
        // 3. Find the stream
        const stream = await db.stream.findFirst({
            where: {
                name: streamId,
                tenantId: tenant.id,
            },
            include: { participants: true },
        });
        if (!stream) {
            return res.status(404).json({ error: `Stream with name ${streamId} not found` });
        }
        // 4. Find the participant
        const participant = await db.participant.findFirst({
            where: {
                streamId: stream.id,
                walletAddress: wallet,
                tenantId: tenant.id,
            },
        });
        if (!participant) {
            return res.status(404).json({ error: "Participant not found" });
        }
        if (participant.leftAt) {
            return res.status(200).json({ message: "Participant already marked as left" });
        }
        // 5. Implement retry mechanism
        const MAX_RETRIES = 3;
        let retries = 0;
        let success = false;
        while (!success && retries < MAX_RETRIES) {
            try {
                await db.participant.update({
                    where: { id: participant.id },
                    data: { leftAt: new Date(leftAt) },
                });
                console.log(`Successfully updated leftAt for participant ${wallet}`);
                success = true;
            }
            catch (error) {
                retries++;
                console.log(`Retrying update (attempt ${retries})...`);
                await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second before retrying
            }
        }
        if (!success) {
            return res.status(500).json({ error: "Failed to update participant after multiple attempts" });
        }
        // 6. If the participant is a host, check if it was the last host and potentially end the stream
        if (participant.userType === "host") {
            const otherActiveHosts = stream.participants.some(p => p.userType === "host" && p.id !== participant.id && !p.leftAt);
            if (!otherActiveHosts) {
                // This was the last active host
                const streamEndTime = new Date();
                await db.stream.update({
                    where: { id: stream.id },
                    data: {
                        isLive: false,
                        endedAt: streamEndTime,
                    },
                });
                // Optionally close the LiveKit room
                // try {
                //   await roomService.deleteRoom(streamId);
                // } catch (roomError) {
                //   console.error("Error closing LiveKit room:", roomError);
                //   // Continue even if room deletion fails
                // }
            }
        }
        res.status(200).json({ message: "Participant updated successfully" });
    }
    catch (error) {
        console.error("Error updating participant left time:", error);
        res.status(500).json({ error: "Internal server error" });
    }
    finally {
        await db.$disconnect();
    }
};
/**
 * Controller for updating participant permissions (promote guest to temp-host or demote temp-host to guest)
 */
export const updateParticipantPermissions = async (req, res) => {
    const { participantId, streamId, wallet, action } = req.body;
    const tenant = req.tenant;
    try {
        // 1. Tenant verification
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // 2. Input validation
        if (!participantId || !streamId || !wallet || !action) {
            return res.status(400).json({
                error: "Missing required fields: participantId, streamId, wallet, or action"
            });
        }
        if (action !== 'promote' && action !== 'demote') {
            return res.status(400).json({
                error: "Action must be either 'promote' or 'demote'"
            });
        }
        if (!isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Invalid wallet address format." });
        }
        // 3. Find the stream
        const stream = await db.stream.findFirst({
            where: {
                name: streamId,
                tenantId: tenant.id,
            },
            include: { participants: true },
        });
        if (!stream) {
            return res.status(404).json({ error: `Stream with name ${streamId} not found` });
        }
        // 4. Find the requesting user (should be a host)
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
            return res.status(403).json({ error: "Only hosts can update participant permissions" });
        }
        // 5. Find the participant being updated
        const participant = await db.participant.findUnique({
            where: { id: participantId },
        });
        if (!participant || participant.streamId !== stream.id) {
            return res.status(404).json({ error: "Participant not found in this stream" });
        }
        // 6. Check if the participant has the expected current role
        const expectedCurrentRole = action === 'promote' ? 'guest' : 'temp-host';
        const newRole = action === 'promote' ? 'temp-host' : 'guest';
        if (participant.userType !== expectedCurrentRole) {
            return res.status(400).json({
                error: `Participant is not a ${expectedCurrentRole}`,
                currentRole: participant.userType
            });
        }
        // 7. Update the participant and permissions
        await db.participant.update({
            where: { id: participant.id },
            data: { userType: newRole },
        });
        // 8. Update LiveKit permissions
        try {
            const livekitParticipant = await roomService.getParticipant(streamId, participantId);
            if (!livekitParticipant) {
                console.error("LiveKit Participant not found:", participantId);
                return res.status(404).json({ error: "LiveKit participant not found" });
            }
            await roomService.updateParticipant(streamId, participantId, undefined, {
                canPublish: action === 'promote',
                canSubscribe: true,
            });
            // 9. Generate a new token with updated permissions
            const newAccessToken = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
                identity: participantId,
                ttl: "60m",
                metadata: JSON.stringify({
                    userName: participant.userName,
                    participantId: participant.id,
                    userType: newRole,
                }),
            });
            newAccessToken.addGrant({
                roomJoin: true,
                room: streamId,
                canPublish: action === 'promote',
                canSubscribe: true,
                canPublishData: true,
                roomRecord: false,
            });
            const token = await newAccessToken.toJwt();
            // 10. Send WebSocket messages to clients
            if (wss && wss.clients) {
                // Send event to all clients in the room
                const event = action === 'promote' ? 'inviteGuest' : 'returnToGuest';
                // Broadcasting room event through WebSocket
                if (clientsByRoom[streamId]) {
                    const roomEventMessage = JSON.stringify({
                        event: event,
                        data: {
                            participantId,
                            roomName: streamId
                        }
                    });
                    clientsByRoom[streamId].forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(roomEventMessage);
                        }
                    });
                }
                // Send token specifically to the participant
                if (clientsByIdentity[participantId]) {
                    const tokenMessage = JSON.stringify({
                        event: 'newToken',
                        data: { token }
                    });
                    if (clientsByIdentity[participantId].readyState === WebSocket.OPEN) {
                        clientsByIdentity[participantId].send(tokenMessage);
                    }
                }
                else {
                    console.warn(`Participant ${participantId} not found in connected clients`);
                }
            }
            const message = action === 'promote'
                ? `Invited participant ${participantId} to speak`
                : `Revoked speaking permissions for participant ${participantId}`;
            res.status(200).json({
                message,
                token,
                participantId,
                newRole
            });
        }
        catch (error) {
            console.error("Error updating LiveKit permissions:", error);
            res.status(500).json({ error: "Failed to update participant permissions in LiveKit" });
        }
    }
    catch (error) {
        console.error(`Error ${action === 'promote' ? 'promoting' : 'demoting'} participant:`, error);
        res.status(500).json({ error: "Internal server error" });
    }
    finally {
        await db.$disconnect();
    }
};
/**
 * Controller for getting participant quiz scores and stats
 */
export const getParticipantScores = async (req, res) => {
    const { streamId } = req.params;
    const tenant = req.tenant;
    try {
        // 1. Tenant verification
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // 2. Input validation
        if (!streamId) {
            return res.status(400).json({ error: "Missing required field: streamId" });
        }
        // 3. Find the stream
        const stream = await db.stream.findFirst({
            where: {
                name: streamId,
                tenantId: tenant.id,
            },
        });
        if (!stream) {
            return res.status(404).json({ error: `Stream with name ${streamId} not found` });
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
                        question: true
                    }
                }
            },
            orderBy: {
                totalPoints: 'desc'
            }
        });
        // 5. Format the response
        const leaderboard = participants.map(participant => {
            const correctAnswers = participant.quizResponses.filter(r => r.isCorrect).length;
            const totalAnswers = participant.quizResponses.length;
            return {
                participantId: participant.id,
                userName: participant.userName,
                walletAddress: participant.walletAddress,
                totalPoints: participant.totalPoints,
                correctAnswers,
                totalAnswers,
                accuracy: totalAnswers > 0 ? Math.round((correctAnswers / totalAnswers) * 100) : 0
            };
        });
        res.status(200).json({
            stream: {
                id: stream.id,
                name: stream.name
            },
            leaderboard
        });
    }
    catch (error) {
        console.error("Error fetching participant scores:", error);
        res.status(500).json({ error: "Internal server error" });
    }
    finally {
        await db.$disconnect();
    }
};
