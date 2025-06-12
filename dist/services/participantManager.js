import { db } from "../prisma.js";
import { clientsByRoom, clientsByIdentity, activeParticipants, } from "../websocket.js";
import WebSocket from "ws";
/**
 * Service for managing participant state across the application
 * Centralizes logic for participant joining, leaving, and reconciliation
 */
export class ParticipantManager {
    /**
     * Mark a participant as having left a stream
     * @param streamId Stream identifier
     * @param walletAddress Wallet address of the participant (optional)
     * @param participantId Participant ID (optional)
     * @returns Promise<boolean> Success indicator
     */
    static async markParticipantAsLeft(streamId, walletAddress, participantId) {
        try {
            // 1. Find the stream
            const stream = await db.stream.findFirst({
                where: { name: streamId },
            });
            if (!stream) {
                console.error(`Stream ${streamId} not found`);
                return false;
            }
            // 2. Find the participant - try by wallet first, then by ID if provided
            const whereClause = {
                streamId: stream.id,
            };
            if (walletAddress) {
                whereClause.walletAddress = walletAddress;
            }
            else if (participantId) {
                whereClause.id = participantId;
            }
            else {
                console.error("Either walletAddress or participantId must be provided");
                return false;
            }
            const participant = await db.participant.findFirst({
                where: whereClause,
            });
            if (!participant) {
                console.error("Participant not found", { streamId, walletAddress, participantId });
                // Log all participants in the stream for debugging
                const allParticipants = await db.participant.findMany({
                    where: { streamId: stream.id },
                    select: { id: true, walletAddress: true, userName: true }
                });
                console.log("Available participants:", JSON.stringify(allParticipants));
                return false;
            }
            // 3. Only update if not already marked as left
            if (participant.leftAt) {
                console.log("Participant already marked as left", { id: participant.id });
                return true;
            }
            // 4. Update with leftAt time
            await db.participant.update({
                where: { id: participant.id },
                data: { leftAt: new Date() },
            });
            console.log(`Marked participant ${participant.id} as left from stream ${streamId}`);
            // 5. If this was a host, check if it was the last one
            if (participant.userType === "host") {
                const otherActiveHosts = await db.participant.findFirst({
                    where: {
                        streamId: stream.id,
                        userType: "host",
                        id: { not: participant.id },
                        leftAt: null,
                    },
                });
                if (!otherActiveHosts) {
                    // This was the last active host, end the stream
                    await db.stream.update({
                        where: { id: stream.id },
                        data: {
                            isLive: false,
                            endedAt: new Date(),
                        },
                    });
                    console.log(`Stream ${streamId} ended - last host left`);
                }
            }
            return true;
        }
        catch (error) {
            console.error("Error marking participant as left:", error);
            return false;
        }
    }
    /**
     * Clean up WebSocket state for a participant
     * @param streamId Stream identifier
     * @param participantId Participant ID
     * @returns boolean Success indicator
     */
    static cleanupWebSocketState(streamId, participantId) {
        try {
            // Remove from identity tracking
            if (clientsByIdentity[participantId]) {
                delete clientsByIdentity[participantId];
            }
            // Remove from room tracking
            if (clientsByRoom[streamId] && clientsByRoom[streamId].size > 0) {
                let found = false;
                [...clientsByRoom[streamId]].forEach(client => {
                    if (client.participantId === participantId) {
                        clientsByRoom[streamId].delete(client);
                        found = true;
                    }
                });
                // Clean up empty room
                if (clientsByRoom[streamId].size === 0) {
                    delete clientsByRoom[streamId];
                }
                // Broadcast the leave event to other participants
                if (found && clientsByRoom[streamId]) {
                    // Convert to array for WebSocket message
                    const participantLeftMessage = JSON.stringify({
                        event: "participantLeft",
                        data: { participantId }
                    });
                    // Send to all remaining clients
                    clientsByRoom[streamId].forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(participantLeftMessage);
                        }
                    });
                }
            }
            // Clear from active participants tracking
            if (activeParticipants[streamId] && activeParticipants[streamId][participantId]) {
                delete activeParticipants[streamId][participantId];
                // Clean up empty room in active participants
                if (Object.keys(activeParticipants[streamId]).length === 0) {
                    delete activeParticipants[streamId];
                }
            }
            return true;
        }
        catch (error) {
            console.error("Error cleaning up WebSocket state:", error);
            return false;
        }
    }
    // Debounce tracking for activity updates
    static lastActivityUpdate = {};
    /**
     * Record participant activity with debouncing
     * @param streamId Stream identifier
     * @param participantId Participant ID
     */
    static updateParticipantActivity(streamId, participantId) {
        const key = `${streamId}-${participantId}`;
        const now = Date.now();
        // Debounce: Only update if last update was more than 5 seconds ago
        if (this.lastActivityUpdate[key] && now - this.lastActivityUpdate[key] < 5000) {
            return; // Skip this update
        }
        if (!activeParticipants[streamId]) {
            activeParticipants[streamId] = {};
        }
        activeParticipants[streamId][participantId] = now;
        this.lastActivityUpdate[key] = now;
        // Temporary debug log to track activity updates
        console.log(`Activity recorded for ${participantId} in ${streamId}`);
    }
    /**
     * Check if a participant is still active in a stream
     * @param streamId Stream identifier
     * @param participantId Participant ID
     * @returns boolean True if active, false otherwise
     */
    static isParticipantActive(streamId, participantId) {
        // A participant is considered active if:
        // 1. They have an active WebSocket connection
        // 2. They've sent a heartbeat recently (last 5 minutes)
        const hasActiveConnection = Boolean(clientsByIdentity[participantId]);
        const hasRecentHeartbeat = Boolean(activeParticipants[streamId]?.[participantId] &&
            Date.now() - activeParticipants[streamId][participantId] < 5 * 60 * 1000 // 5 minutes
        );
        return hasActiveConnection || hasRecentHeartbeat;
    }
    /**
     * Get last activity time for a participant
     * @param streamId Stream identifier
     * @param participantId Participant ID
     * @returns number|null Timestamp of last activity or null
     */
    static getLastActivity(streamId, participantId) {
        return activeParticipants[streamId]?.[participantId] || null;
    }
}
