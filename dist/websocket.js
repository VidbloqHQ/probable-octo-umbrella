import WebSocket from "ws";
import { ParticipantManager } from "./services/participantManager.js";
// Room and guest request state storage
const roomStates = {};
export const guestRequests = {};
export const raisedHands = {};
// Active addons state
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
// Track pending disconnects to handle reconnections
const pendingDisconnects = {};
// Track participant heartbeats for better disconnect detection
const participantHeartbeats = {};
// Grace period settings
const DISCONNECT_GRACE_PERIOD = 3000; // 3 seconds
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 60000; // 60 seconds - consider participant inactive
export let wss;
// Generate unique connection ID
const generateConnectionId = () => {
    return `conn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};
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
    }, HEARTBEAT_INTERVAL);
    // Check for inactive participants
    const inactivityCheckInterval = setInterval(() => {
        const now = Date.now();
        Object.entries(participantHeartbeats).forEach(([participantId, lastSeen]) => {
            if (now - lastSeen > HEARTBEAT_TIMEOUT) {
                console.log(`Participant ${participantId} is inactive (no heartbeat for ${HEARTBEAT_TIMEOUT}ms)`);
                // Find the client and handle disconnect if they're truly gone
                const client = clientsByIdentity[participantId];
                if (client && client.readyState !== WebSocket.OPEN) {
                    handleDisconnect(client, true); // Force immediate disconnect
                }
                delete participantHeartbeats[participantId];
            }
        });
    }, 10000); // Check every 10 seconds
    wss.on("close", () => {
        clearInterval(heartbeatInterval);
        clearInterval(inactivityCheckInterval);
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
    const broadcastToRoom = (roomName, event, data) => {
        const message = JSON.stringify({ event, data });
        const clients = clientsByRoom[roomName] || new Set();
        // Skip logging for high-frequency events
        const isHighFrequencyEvent = ['ping', 'pong', 'timeSync'].includes(event);
        if (!isHighFrequencyEvent) {
            console.log(`Broadcasting ${event} to ${clients.size} clients in room ${roomName}`);
        }
        if (clients.size === 0) {
            if (!isHighFrequencyEvent) {
                console.log(`No clients in room ${roomName}. Event ${event} not delivered.`);
            }
            return;
        }
        let sentCount = 0;
        clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(message);
                    sentCount++;
                }
                catch (error) {
                    console.error(`Error broadcasting to client in room ${roomName}:`, error);
                }
            }
        });
        // Only log successful sends for non-high-frequency events
        if (!isHighFrequencyEvent) {
            console.log(`Successfully sent ${event} to ${sentCount}/${clients.size} clients in room ${roomName}`);
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
     * Handles client disconnection with grace period
     * @param ws WebSocket connection
     * @param immediate If true, skip grace period
     */
    const handleDisconnect = (ws, immediate = false) => {
        const { roomName, participantId } = ws;
        if (!roomName || !participantId) {
            return;
        }
        console.log(`HandleDisconnect called for ${participantId}, immediate: ${immediate}`);
        const performDisconnect = () => {
            console.log(`Performing disconnect for ${participantId} from room ${roomName}`);
            // Clear any pending disconnect timeout
            if (pendingDisconnects[participantId]) {
                clearTimeout(pendingDisconnects[participantId]);
                delete pendingDisconnects[participantId];
            }
            // Remove client from tracking collections
            if (clientsByRoom[roomName]) {
                clientsByRoom[roomName].delete(ws);
                // Clean up empty room collections
                if (clientsByRoom[roomName].size === 0) {
                    delete clientsByRoom[roomName];
                }
            }
            // Only remove from clientsByIdentity if this is the current connection
            if (clientsByIdentity[participantId] === ws) {
                delete clientsByIdentity[participantId];
            }
            // Remove from heartbeat tracking
            delete participantHeartbeats[participantId];
            // Update room state
            if (roomStates[roomName]) {
                // Remove participant from room participants
                roomStates[roomName].participants.delete(participantId);
                // Remove participant's request from guest requests
                if (guestRequests[roomName]) {
                    const hadRequest = guestRequests[roomName].some(req => req.participantId === participantId);
                    guestRequests[roomName] = guestRequests[roomName].filter((req) => req.participantId !== participantId);
                    if (hadRequest) {
                        console.log(`Removed request for ${participantId} from room ${roomName}. Remaining requests: ${guestRequests[roomName].length}`);
                        // Broadcast updated guest requests
                        broadcastToRoom(roomName, "guestRequestsUpdate", guestRequests[roomName]);
                    }
                }
                // Remove participant's raised hand
                if (raisedHands[roomName]) {
                    const hadRaisedHand = raisedHands[roomName].some((hand) => hand.participantId === participantId);
                    if (hadRaisedHand) {
                        raisedHands[roomName] = raisedHands[roomName].filter((hand) => hand.participantId !== participantId);
                        console.log(`Removed raised hand for disconnected participant ${participantId}`);
                        // Broadcast updated raised hands
                        broadcastToRoom(roomName, "raisedHandsUpdate", raisedHands[roomName]);
                    }
                }
                // Broadcast participant left event
                broadcastToRoom(roomName, "participantLeft", { participantId });
                // Clean up empty room state
                if (roomStates[roomName].participants.size === 0) {
                    delete roomStates[roomName];
                    delete guestRequests[roomName];
                    delete raisedHands[roomName];
                }
            }
        };
        if (immediate) {
            performDisconnect();
        }
        else {
            // Check if there's already a pending disconnect
            if (pendingDisconnects[participantId]) {
                console.log(`Disconnect already pending for ${participantId}`);
                return;
            }
            // Add grace period to handle temporary disconnects
            console.log(`Starting ${DISCONNECT_GRACE_PERIOD}ms grace period for ${participantId}`);
            pendingDisconnects[participantId] = setTimeout(() => {
                // Check if the participant has reconnected
                const currentClient = clientsByIdentity[participantId];
                if (currentClient && currentClient !== ws && currentClient.readyState === WebSocket.OPEN) {
                    console.log(`Participant ${participantId} reconnected with different connection`);
                    delete pendingDisconnects[participantId];
                    return;
                }
                performDisconnect();
            }, DISCONNECT_GRACE_PERIOD);
        }
    };
    wss.on("connection", (ws) => {
        const extWs = ws;
        extWs.isAlive = true;
        extWs.lastActivityTime = Date.now();
        extWs.connectionId = generateConnectionId();
        console.log(`New WebSocket connection established: ${extWs.connectionId}`);
        // Send initial addon state
        extWs.send(JSON.stringify({ event: "addonState", data: activeAddons }));
        // Handle ping responses
        extWs.on("pong", () => {
            extWs.isAlive = true;
            extWs.lastActivityTime = Date.now();
        });
        extWs.on("message", (message) => {
            try {
                const { event, data } = JSON.parse(message.toString());
                // Update last activity time
                extWs.lastActivityTime = Date.now();
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
                        console.log(`JoinRoom request: ${participantId} to ${roomName}`);
                        // Cancel any pending disconnect for this participant
                        if (pendingDisconnects[participantId]) {
                            clearTimeout(pendingDisconnects[participantId]);
                            delete pendingDisconnects[participantId];
                            console.log(`Cancelled pending disconnect for ${participantId}`);
                        }
                        // Check if this is a reconnection
                        const existingClient = clientsByIdentity[participantId];
                        const isReconnection = !!existingClient && existingClient !== extWs;
                        if (isReconnection) {
                            console.log(`Participant ${participantId} is reconnecting`);
                            // Remove the old connection from room
                            if (existingClient.roomName && clientsByRoom[existingClient.roomName]) {
                                clientsByRoom[existingClient.roomName].delete(existingClient);
                            }
                            // Close the old connection
                            existingClient.close();
                        }
                        // Store room and identity in the WebSocket object
                        extWs.roomName = roomName;
                        extWs.participantId = participantId;
                        // Add client to tracking collections
                        if (!clientsByRoom[roomName]) {
                            clientsByRoom[roomName] = new Set();
                        }
                        clientsByRoom[roomName].add(extWs);
                        clientsByIdentity[participantId] = extWs;
                        // Update heartbeat
                        participantHeartbeats[participantId] = Date.now();
                        console.log(`Client ${participantId} ${isReconnection ? 'reconnected to' : 'joined'} room ${roomName}. Total clients in room: ${clientsByRoom[roomName].size}`);
                        // Initialize room state if it doesn't exist
                        let isNewRoom = false;
                        if (!roomStates[roomName]) {
                            isNewRoom = true;
                            roomStates[roomName] = {
                                currentTime: 0,
                                executedActions: new Set(),
                                guestRequests: [],
                                participants: new Set(),
                            };
                            startRoomTimer(roomName);
                            guestRequests[roomName] = [];
                            raisedHands[roomName] = [];
                        }
                        // Check if participant is new to the room
                        const isNewParticipant = !roomStates[roomName].participants.has(participantId);
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
                        // Broadcast participant joined ONLY if they're truly new to the room
                        if (isNewParticipant && !isReconnection) {
                            console.log(`Broadcasting participantJoined for ${participantId}`);
                            broadcastToRoom(roomName, "participantJoined", { participantId });
                        }
                        else if (isReconnection) {
                            console.log(`Skipping participantJoined broadcast for reconnection: ${participantId}`);
                        }
                        // Send current guest requests state to newly joined participant
                        setTimeout(() => {
                            console.log(`Sending existing ${guestRequests[roomName]?.length || 0} guest requests to participant ${participantId}`);
                            if (extWs.readyState === WebSocket.OPEN) {
                                extWs.send(JSON.stringify({
                                    event: "guestRequestsUpdate",
                                    data: guestRequests[roomName] || [],
                                }));
                            }
                        }, 500);
                        // Send current raised hands state to newly joined participant
                        setTimeout(() => {
                            console.log(`Sending existing ${raisedHands[roomName]?.length || 0} raised hands to participant ${participantId}`);
                            if (extWs.readyState === WebSocket.OPEN) {
                                extWs.send(JSON.stringify({
                                    event: "raisedHandsUpdate",
                                    data: raisedHands[roomName] || [],
                                }));
                            }
                        }, 600);
                        break;
                    }
                    case "getGuestRequests": {
                        const { roomName } = data;
                        if (extWs.participantId) {
                            console.log(`Received getGuestRequests from ${extWs.participantId} for room ${roomName}`);
                            // Send the current guest requests directly to the requesting client
                            extWs.send(JSON.stringify({
                                event: "guestRequestsUpdate",
                                data: guestRequests[roomName] || [],
                            }));
                        }
                        break;
                    }
                    case "getRaisedHands": {
                        const { roomName } = data;
                        if (extWs.participantId) {
                            console.log(`Received getRaisedHands from ${extWs.participantId} for room ${roomName}`);
                            // Send the current raised hands directly to the requesting client
                            extWs.send(JSON.stringify({
                                event: "raisedHandsUpdate",
                                data: raisedHands[roomName] || [],
                            }));
                        }
                        break;
                    }
                    case "requestToSpeak": {
                        const { participantId, name, roomName, walletAddress } = data;
                        console.log("Received request to speak:", {
                            participantId,
                            roomName,
                            walletAddress,
                            timestamp: new Date().toISOString(),
                        });
                        const newRequest = { participantId, name, walletAddress };
                        if (!guestRequests[roomName]) {
                            guestRequests[roomName] = [];
                        }
                        // Check if request already exists
                        const existingRequest = guestRequests[roomName].find((req) => req.participantId === participantId);
                        if (!existingRequest) {
                            guestRequests[roomName].push(newRequest);
                            console.log(`Added request for ${participantId} in room ${roomName}. Total requests: ${guestRequests[roomName].length}`);
                            // Store requests persistently to be able to send them to newly joined clients
                            const clientCount = clientsByRoom[roomName]?.size || 0;
                            console.log(`Broadcasting guestRequestsUpdate to ${clientCount} clients in room ${roomName}`);
                            broadcastToRoom(roomName, "guestRequestsUpdate", guestRequests[roomName]);
                            // If there are no clients in the room, log this fact
                            if (!clientsByRoom[roomName] ||
                                clientsByRoom[roomName].size === 0) {
                                console.log(`Warning: No clients in room ${roomName} to receive guest request updates.`);
                            }
                        }
                        else {
                            console.log(`Request for ${participantId} already exists in room ${roomName}`);
                        }
                        break;
                    }
                    case "raiseHand": {
                        const { participantId, name, roomName, walletAddress } = data;
                        console.log("Received raise hand:", {
                            participantId,
                            roomName,
                            timestamp: new Date().toISOString(),
                        });
                        // Initialize raised hands array if it doesn't exist
                        if (!raisedHands[roomName]) {
                            raisedHands[roomName] = [];
                        }
                        // Check if hand is already raised
                        const existingHand = raisedHands[roomName].find((hand) => hand.participantId === participantId);
                        if (!existingHand) {
                            // Add raised hand
                            const newRaisedHand = {
                                participantId,
                                name,
                                walletAddress,
                                timestamp: Date.now(),
                                userType: "co-host", // You might want to determine this from participant metadata
                            };
                            raisedHands[roomName].push(newRaisedHand);
                            console.log(`Added raised hand for ${participantId} in room ${roomName}. Total raised hands: ${raisedHands[roomName].length}`);
                            // Broadcast updated raised hands to all clients in the room
                            broadcastToRoom(roomName, "raisedHandsUpdate", raisedHands[roomName]);
                        }
                        else {
                            console.log(`Hand already raised for ${participantId} in room ${roomName}`);
                        }
                        break;
                    }
                    case "lowerHand": {
                        const { participantId, roomName } = data;
                        console.log("Received lower hand:", {
                            participantId,
                            roomName,
                        });
                        if (raisedHands[roomName]) {
                            const initialLength = raisedHands[roomName].length;
                            // Remove raised hand
                            raisedHands[roomName] = raisedHands[roomName].filter((hand) => hand.participantId !== participantId);
                            if (raisedHands[roomName].length < initialLength) {
                                console.log(`Lowered hand for ${participantId} in room ${roomName}. Remaining raised hands: ${raisedHands[roomName].length}`);
                                // Broadcast updated raised hands to all clients in the room
                                broadcastToRoom(roomName, "raisedHandsUpdate", raisedHands[roomName]);
                            }
                        }
                        break;
                    }
                    case "acknowledgeHand": {
                        const { participantId, roomName } = data;
                        console.log("Host acknowledged raised hand:", {
                            participantId,
                            roomName,
                        });
                        if (raisedHands[roomName]) {
                            // Remove the acknowledged hand
                            raisedHands[roomName] = raisedHands[roomName].filter((hand) => hand.participantId !== participantId);
                            // Broadcast updated raised hands
                            broadcastToRoom(roomName, "raisedHandsUpdate", raisedHands[roomName]);
                            // Send acknowledgment to the specific participant
                            sendToClient(participantId, "handAcknowledged", { roomName });
                        }
                        break;
                    }
                    // case "inviteGuest": {
                    //   const { participantId, roomName } = data as {
                    //     participantId: string;
                    //     roomName: string;
                    //   };
                    //   console.log(
                    //     `Processing invitation for ${participantId} in room ${roomName}`
                    //   );
                    //   if (guestRequests[roomName]) {
                    //     // Find the participant's request
                    //     const requestIndex = guestRequests[roomName].findIndex(
                    //       (req) => req.participantId === participantId
                    //     );
                    //     if (requestIndex !== -1) {
                    //       // Remove the request from the request list
                    //       guestRequests[roomName].splice(requestIndex, 1);
                    //       console.log(
                    //         `Removed request for ${participantId} from room ${roomName}. Remaining requests: ${guestRequests[roomName].length}`
                    //       );
                    //       // Broadcast the updated guest request list to all clients in the room
                    //       broadcastToRoom(
                    //         roomName,
                    //         "guestRequestsUpdate",
                    //         guestRequests[roomName]
                    //       );
                    //       // Broadcast the invitation event to the room
                    //       broadcastToRoom(roomName, "inviteGuest", {
                    //         participantId,
                    //         roomName,
                    //       });
                    //     } else {
                    //       console.warn(
                    //         `Request for ${participantId} not found in room ${roomName}`
                    //       );
                    //     }
                    //   } else {
                    //     console.warn(`No guest requests found for room ${roomName}`);
                    //   }
                    //   break;
                    // }
                    // Add this to your WebSocket server's message handler in the inviteGuest case
                    case "inviteGuest": {
                        const { participantId, roomName } = data;
                        console.log(`Processing invitation for ${participantId} in room ${roomName}`);
                        if (guestRequests[roomName]) {
                            // Find the participant's request
                            const requestIndex = guestRequests[roomName].findIndex((req) => req.participantId === participantId);
                            if (requestIndex !== -1) {
                                // Remove the request from the request list
                                const removedRequest = guestRequests[roomName].splice(requestIndex, 1)[0];
                                console.log(`Removed request for ${participantId} from room ${roomName}. Remaining requests: ${guestRequests[roomName].length}`);
                                // IMPORTANT: Broadcast the updated guest request list FIRST
                                broadcastToRoom(roomName, "guestRequestsUpdate", guestRequests[roomName]);
                                // Small delay to ensure the guestRequestsUpdate is processed first
                                setTimeout(() => {
                                    // Then broadcast the invitation event to the room
                                    broadcastToRoom(roomName, "inviteGuest", {
                                        participantId,
                                        roomName,
                                    });
                                }, 100);
                                // Log the successful removal for debugging
                                console.log(`Successfully processed invitation for ${participantId}:`, {
                                    removedRequest,
                                    remainingRequests: guestRequests[roomName].length,
                                    timestamp: new Date().toISOString()
                                });
                            }
                            else {
                                console.warn(`Request for ${participantId} not found in room ${roomName}. Current requests:`, guestRequests[roomName].map(req => req.participantId));
                            }
                        }
                        else {
                            console.warn(`No guest requests found for room ${roomName}`);
                        }
                        break;
                    }
                    case "returnToGuest": {
                        const { participantId, roomName } = data;
                        console.log(`Processing return to guest for ${participantId} in room ${roomName}`);
                        if (guestRequests[roomName]) {
                            // Find the participant's request
                            const requestIndex = guestRequests[roomName].findIndex((req) => req.participantId === participantId);
                            if (requestIndex !== -1) {
                                // Remove the request from the request list
                                guestRequests[roomName].splice(requestIndex, 1);
                                console.log(`Removed request for ${participantId} from room ${roomName}. Remaining requests: ${guestRequests[roomName].length}`);
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
                        // Validate the reaction data
                        if (!roomName || !reaction || !sender) {
                            console.error("Invalid reaction data received:", { roomName, reaction, sender });
                            break;
                        }
                        // Check if the sender is actually in the room
                        if (extWs.roomName !== roomName) {
                            console.error(`Sender ${extWs.participantId} trying to send reaction to room ${roomName} but is in room ${extWs.roomName}`);
                            break;
                        }
                        // Verify room exists
                        if (!clientsByRoom[roomName]) {
                            console.error(`Room ${roomName} does not exist or has no clients`);
                            break;
                        }
                        // Add timestamp, ID, and roomName to ensure uniqueness and proper routing
                        const reactionData = {
                            reaction,
                            sender,
                            timestamp: Date.now(),
                            id: `${reaction}-${typeof sender === 'string' ? sender : 'unknown'}-${Date.now()}-${Math.random()}`,
                            roomName // Include roomName in the reaction data
                        };
                        console.log(`Broadcasting reaction from ${typeof sender === 'string' ? sender : 'unknown'} in room ${roomName}`);
                        console.log(`Room ${roomName} has ${clientsByRoom[roomName].size} connected clients`);
                        // Get all clients in the room
                        const clients = clientsByRoom[roomName];
                        let sentCount = 0;
                        let failedCount = 0;
                        const clientDetails = [];
                        clients.forEach((client) => {
                            const clientInfo = `${client.participantId || 'unknown'} (state: ${client.readyState})`;
                            clientDetails.push(clientInfo);
                            if (client.readyState === WebSocket.OPEN) {
                                try {
                                    client.send(JSON.stringify({
                                        event: "receiveReaction",
                                        data: reactionData
                                    }));
                                    sentCount++;
                                    console.log(`✓ Sent reaction to client: ${client.participantId || 'unknown'}`);
                                }
                                catch (error) {
                                    console.error(`✗ Error sending reaction to client ${client.participantId}:`, error);
                                    failedCount++;
                                }
                            }
                            else {
                                console.warn(`✗ Client ${client.participantId} in room ${roomName} has readyState: ${client.readyState}`);
                                failedCount++;
                            }
                        });
                        console.log(`Reaction broadcast summary for room ${roomName}:`);
                        console.log(`- Total clients: ${clients.size}`);
                        console.log(`- Successful sends: ${sentCount}`);
                        console.log(`- Failed sends: ${failedCount}`);
                        console.log(`- Client details: ${clientDetails.join(', ')}`);
                        // If no clients received the reaction, log a detailed warning
                        if (sentCount === 0) {
                            console.error(`CRITICAL: No clients received the reaction in room ${roomName}!`);
                            console.error(`Room state: ${JSON.stringify({
                                roomExists: !!roomStates[roomName],
                                participantCount: roomStates[roomName]?.participants.size || 0,
                                participants: Array.from(roomStates[roomName]?.participants || [])
                            })}`);
                        }
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
                    case "participantActive": {
                        const { participantId, roomName, timestamp } = data;
                        // Update heartbeat
                        participantHeartbeats[participantId] = Date.now();
                        // Use the centralized manager
                        ParticipantManager.updateParticipantActivity(roomName, participantId);
                        console.log(`Participant ${participantId} active in room ${roomName}`);
                        break;
                    }
                    case "newToken": {
                        const { participantId, token, newUserType } = data;
                        sendToClient(participantId, "newToken", { token, newUserType });
                        break;
                    }
                    case "pong": {
                        // Handle pong message to keep connection alive
                        extWs.isAlive = true;
                        extWs.lastActivityTime = Date.now();
                        if (extWs.participantId) {
                            participantHeartbeats[extWs.participantId] = Date.now();
                        }
                        break;
                    }
                    default: {
                        console.warn(`Unhandled WebSocket event: ${event}`);
                    }
                }
            }
            catch (error) {
                console.error("Error handling WebSocket message:", error);
            }
        });
        extWs.on("close", () => {
            console.log(`WebSocket connection closed: ${extWs.connectionId}`);
            handleDisconnect(extWs);
        });
        extWs.on("error", (error) => {
            console.error("WebSocket error:", error);
            handleDisconnect(extWs, true); // Immediate disconnect on error
        });
    });
    return wss;
};
export default createWebSocketServer;
