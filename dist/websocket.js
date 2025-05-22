import WebSocket from "ws";
import { ParticipantManager } from "./services/participantManager.js";
// Room and guest request state storage
const roomStates = {};
export const guestRequests = {};
// Active addons state - without Quiz
const activeAddons = {
    Custom: { type: "Custom", isActive: false },
    "Q&A": { type: "Q&A", isActive: false },
    Poll: { type: "Poll", isActive: false },
    Quiz: { type: "Quiz", isActive: false },
};
export const activeParticipants = {};
// Keep track of connected clients by room and by identity
export const clientsByRoom = {};
export const clientsByIdentity = {};
export let wss;
/**
 * Creates a WebSocket server
 * @param server HTTP server to attach the WebSocket server to
 * @returns WebSocket server instance
 */
const createWebSocketServer = (server) => {
    wss = new WebSocket.Server({
        server,
        path: "/ws",
    });
    // Set up heartbeat interval to detect disconnected clients
    const heartbeatInterval = setInterval(() => {
        wss.clients.forEach((ws) => {
            const extWs = ws;
            if (extWs.isAlive === false) {
                handleDisconnect(extWs);
                return extWs.terminate();
            }
            extWs.isAlive = false;
            extWs.send(JSON.stringify({ event: "ping" }));
        });
    }, 30000); // Check every 30 seconds
    wss.on("close", () => {
        clearInterval(heartbeatInterval);
    });
    // Initialize room timer for time synchronization
    const startRoomTimer = (roomName) => {
        const interval = setInterval(() => {
            if (roomStates[roomName]) {
                roomStates[roomName].currentTime += 1;
                broadcastToRoom(roomName, "timeSync", roomStates[roomName].currentTime);
            }
            else {
                clearInterval(interval);
            }
        }, 1000);
    };
    /**
     * Broadcasts a message to all clients in a room
     * @param roomName Name of the room to broadcast to
     * @param event Event type
     * @param data Event data
     */
    // const broadcastToRoom = <T>(roomName: string, event: string, data: T) => {
    //   const message = JSON.stringify({ event, data });
    //   const clients = clientsByRoom[roomName] || new Set();
    //   console.log(
    //     `Broadcasting ${event} to ${clients.size} clients in room ${roomName}`
    //   );
    //   if (clients.size === 0) {
    //     console.log(
    //       `No clients in room ${roomName}. Event ${event} not delivered.`
    //     );
    //     return;
    //   }
    //   let sentCount = 0;
    //   clients.forEach((client) => {
    //     if (client.readyState === WebSocket.OPEN) {
    //       client.send(message);
    //       sentCount++;
    //     }
    //   });
    //   console.log(
    //     `Successfully sent ${event} to ${sentCount}/${clients.size} clients in room ${roomName}`
    //   );
    // };
    // In websocket.ts, modify the broadcastToRoom function:
    const broadcastToRoom = (roomName, event, data) => {
        const message = JSON.stringify({ event, data });
        const clients = clientsByRoom[roomName] || new Set();
        // Skip logging for high-frequency events
        const isHighFrequencyEvent = ['ping', 'pong', 'timeSync'].includes(event);
        if (!isHighFrequencyEvent) {
            // console.log(`Broadcasting ${event} to ${clients.size} clients in room ${roomName}`);
        }
        if (clients.size === 0) {
            if (!isHighFrequencyEvent) {
                // console.log(`No clients in room ${roomName}. Event ${event} not delivered.`);
            }
            return;
        }
        let sentCount = 0;
        clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
                sentCount++;
            }
        });
        // Only log successful sends for non-high-frequency events
        if (!isHighFrequencyEvent) {
            // console.log(`Successfully sent ${event} to ${sentCount}/${clients.size} clients in room ${roomName}`);
        }
    };
    /**
     * Sends a message to a specific client by identity
     * @param identity Client identity
     * @param event Event type
     * @param data Event data
     */
    const sendToClient = (identity, event, data) => {
        const client = clientsByIdentity[identity];
        if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ event, data }));
        }
    };
    /**
     * Handles client disconnection
     * @param ws WebSocket connection
     */
    const handleDisconnect = (ws) => {
        const { roomName, participantId } = ws;
        if (roomName && participantId) {
            // console.log(
            //   `Participant ${participantId} disconnected from room ${roomName}`
            // );
            // Remove client from tracking collections
            if (clientsByRoom[roomName]) {
                clientsByRoom[roomName].delete(ws);
                // Clean up empty room collections
                if (clientsByRoom[roomName].size === 0) {
                    delete clientsByRoom[roomName];
                }
            }
            if (clientsByIdentity[participantId]) {
                delete clientsByIdentity[participantId];
            }
            // Update room state
            if (roomStates[roomName]) {
                // Remove participant from room participants
                roomStates[roomName].participants.delete(participantId);
                // Remove participant's request from guest requests
                if (guestRequests[roomName]) {
                    guestRequests[roomName] = guestRequests[roomName].filter((req) => req.participantId !== participantId);
                    // console.log(
                    //   `Removed request for ${participantId} from room ${roomName}. Remaining requests: ${guestRequests[roomName].length}`
                    // );
                    // Broadcast updated guest requests
                    broadcastToRoom(roomName, "guestRequestsUpdate", guestRequests[roomName]);
                }
                // Broadcast participant left event
                broadcastToRoom(roomName, "participantLeft", { participantId });
                // Clean up empty room state
                if (roomStates[roomName].participants.size === 0) {
                    delete roomStates[roomName];
                    delete guestRequests[roomName];
                }
            }
        }
    };
    wss.on("connection", (ws) => {
        const extWs = ws;
        extWs.isAlive = true;
        // Send initial addon state
        extWs.send(JSON.stringify({ event: "addonState", data: activeAddons }));
        // Handle ping responses
        extWs.on("pong", () => {
            extWs.isAlive = true;
        });
        extWs.on("message", (message) => {
            try {
                const { event, data } = JSON.parse(message.toString());
                switch (event) {
                    case "authenticate": {
                        // Handle authentication (check API credentials)
                        const { apiKey, apiSecret } = data;
                        // Simple authentication example - in production, verify these against your database
                        if (apiKey && apiSecret) {
                            extWs.send(JSON.stringify({
                                event: "authResponse",
                                data: { success: true },
                            }));
                        }
                        else {
                            extWs.send(JSON.stringify({
                                event: "authResponse",
                                data: { success: false, error: "Invalid API credentials" },
                            }));
                        }
                        break;
                    }
                    case "joinRoom": {
                        const { roomName, participantId } = data;
                        // Store room and identity in the WebSocket object
                        extWs.roomName = roomName;
                        extWs.participantId = participantId;
                        // Add client to tracking collections
                        if (!clientsByRoom[roomName]) {
                            clientsByRoom[roomName] = new Set();
                        }
                        clientsByRoom[roomName].add(extWs);
                        clientsByIdentity[participantId] = extWs;
                        // console.log(
                        //   `Client ${participantId} joined room ${roomName}. Total clients in room: ${clientsByRoom[roomName].size}`
                        // );
                        // Initialize room state if it doesn't exist
                        if (!roomStates[roomName]) {
                            roomStates[roomName] = {
                                currentTime: 0,
                                executedActions: new Set(),
                                guestRequests: [],
                                participants: new Set(),
                            };
                            startRoomTimer(roomName);
                            guestRequests[roomName] = [];
                        }
                        // Add participant to room state
                        roomStates[roomName].participants.add(participantId);
                        // Send initial sync data
                        extWs.send(JSON.stringify({
                            event: "initialSync",
                            data: {
                                currentTime: roomStates[roomName].currentTime,
                                executedActions: Array.from(roomStates[roomName].executedActions),
                                joinTime: roomStates[roomName].currentTime,
                            },
                        }));
                        // Broadcast participant joined event
                        broadcastToRoom(roomName, "participantJoined", { participantId });
                        // IMPORTANT: Make sure to send current guest requests state to newly joined participant
                        // with a small delay to ensure connection is ready
                        setTimeout(() => {
                            // console.log(
                            //   `Sending existing ${
                            //     guestRequests[roomName]?.length || 0
                            //   } guest requests to newly joined participant ${participantId}`
                            // );
                            if (extWs.readyState === WebSocket.OPEN) {
                                extWs.send(JSON.stringify({
                                    event: "guestRequestsUpdate",
                                    data: guestRequests[roomName] || [],
                                }));
                            }
                        }, 500);
                        break;
                    }
                    case "getGuestRequests": {
                        const { roomName } = data;
                        if (extWs.participantId) {
                            // console.log(
                            //   `Received getGuestRequests from ${extWs.participantId} for room ${roomName}`
                            // );
                            // Send the current guest requests directly to the requesting client
                            extWs.send(JSON.stringify({
                                event: "guestRequestsUpdate",
                                data: guestRequests[roomName] || [],
                            }));
                        }
                        break;
                    }
                    case "requestToSpeak": {
                        const { participantId, name, roomName, walletAddress } = data;
                        // console.log("Received request to speak:", {
                        //   participantId,
                        //   roomName,
                        //   walletAddress,
                        //   timestamp: new Date().toISOString(),
                        // });
                        const newRequest = { participantId, name, walletAddress };
                        if (!guestRequests[roomName]) {
                            guestRequests[roomName] = [];
                        }
                        // Check if request already exists
                        const existingRequest = guestRequests[roomName].find((req) => req.participantId === participantId);
                        if (!existingRequest) {
                            guestRequests[roomName].push(newRequest);
                            // console.log(
                            //   `Added request for ${participantId} in room ${roomName}. Total requests: ${guestRequests[roomName].length}`
                            // );
                            // Store requests persistently to be able to send them to newly joined clients
                            const clientCount = clientsByRoom[roomName]?.size || 0;
                            // console.log(
                            //   `Broadcasting guestRequestsUpdate to ${clientCount} clients in room ${roomName}`
                            // );
                            broadcastToRoom(roomName, "guestRequestsUpdate", guestRequests[roomName]);
                            // If there are no clients in the room, log this fact
                            if (!clientsByRoom[roomName] ||
                                clientsByRoom[roomName].size === 0) {
                                // console.log(
                                //   `Warning: No clients in room ${roomName} to receive guest request updates.`
                                // );
                            }
                        }
                        else {
                            // console.log(
                            //   `Request for ${participantId} already exists in room ${roomName}`
                            // );
                        }
                        break;
                    }
                    case "inviteGuest": {
                        const { participantId, roomName } = data;
                        // console.log(
                        //   `Processing invitation for ${participantId} in room ${roomName}`
                        // );
                        if (guestRequests[roomName]) {
                            // Find the participant's request
                            const requestIndex = guestRequests[roomName].findIndex((req) => req.participantId === participantId);
                            if (requestIndex !== -1) {
                                // Remove the request from the request list
                                guestRequests[roomName].splice(requestIndex, 1);
                                // console.log(
                                //   `Removed request for ${participantId} from room ${roomName}. Remaining requests: ${guestRequests[roomName].length}`
                                // );
                                // Broadcast the updated guest request list to all clients in the room
                                broadcastToRoom(roomName, "guestRequestsUpdate", guestRequests[roomName]);
                                // Broadcast the invitation event to the room
                                // Note: This doesn't change permissions - it just notifies clients
                                // The actual permission change is done through the API endpoint
                                broadcastToRoom(roomName, "inviteGuest", {
                                    participantId,
                                    roomName,
                                });
                            }
                            else {
                                // console.warn(
                                //   `Request for ${participantId} not found in room ${roomName}`
                                // );
                            }
                        }
                        else {
                            // console.warn(`No guest requests found for room ${roomName}`);
                        }
                        break;
                    }
                    case "returnToGuest": {
                        const { participantId, roomName } = data;
                        // console.log(
                        //   `Processing return to guest for ${participantId} in room ${roomName}`
                        // );
                        if (guestRequests[roomName]) {
                            // Find the participant's request
                            const requestIndex = guestRequests[roomName].findIndex((req) => req.participantId === participantId);
                            if (requestIndex !== -1) {
                                // Remove the request from the request list
                                guestRequests[roomName].splice(requestIndex, 1);
                                // console.log(
                                //   `Removed request for ${participantId} from room ${roomName}. Remaining requests: ${guestRequests[roomName].length}`
                                // );
                                // Broadcast the updated guest request list to all clients in the room
                                broadcastToRoom(roomName, "guestRequestsUpdate", guestRequests[roomName]);
                                // Broadcast the return to guest event to the room
                                broadcastToRoom(roomName, "returnToGuest", {
                                    participantId,
                                    roomName,
                                });
                            }
                            else {
                                console.warn(`Request for ${participantId} not found in room ${roomName}`);
                            }
                        }
                        break;
                    }
                    case "actionExecuted": {
                        const { roomName, actionId } = data;
                        if (roomStates[roomName]) {
                            roomStates[roomName].executedActions.add(actionId);
                            broadcastToRoom(roomName, "actionExecutedSync", actionId);
                        }
                        break;
                    }
                    case "sendReaction": {
                        const { roomName, reaction, sender } = data;
                        broadcastToRoom(roomName, "receiveReaction", { reaction, sender });
                        break;
                    }
                    case "startAddon": {
                        const { type, data: addonData } = data;
                        activeAddons[type] = {
                            type,
                            isActive: true,
                            data: addonData,
                        };
                        wss.clients.forEach((client) => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    event: "addonStateUpdate",
                                    data: activeAddons[type],
                                }));
                            }
                        });
                        break;
                    }
                    case "stopAddon": {
                        const type = data;
                        activeAddons[type] = {
                            type,
                            isActive: false,
                            data: null,
                        };
                        wss.clients.forEach((client) => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    event: "addonStateUpdate",
                                    data: activeAddons[type],
                                }));
                            }
                        });
                        break;
                    }
                    // In websocket.ts, modify the participantActive handler
                    case "participantActive": {
                        const { participantId, roomName, timestamp } = data;
                        // Use the centralized manager
                        ParticipantManager.updateParticipantActivity(roomName, participantId);
                        // console.log(`Participant ${participantId} active in room ${roomName}`);
                        break;
                    }
                    case "newToken": {
                        const { participantId, token } = data;
                        sendToClient(participantId, "newToken", { token });
                        break;
                    }
                    case "pong": {
                        // Handle pong message to keep connection alive
                        extWs.isAlive = true;
                        break;
                    }
                }
            }
            catch (error) {
                // console.error("Error handling WebSocket message:", error);
            }
        });
        extWs.on("close", () => {
            handleDisconnect(extWs);
        });
        extWs.on("error", (error) => {
            console.error("WebSocket error:", error);
            handleDisconnect(extWs);
        });
    });
    return wss;
};
export default createWebSocketServer;
