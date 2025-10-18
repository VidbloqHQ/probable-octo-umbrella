import { Server as HttpServer } from "http";
import WebSocket from "ws";
import { ParticipantManager } from "./services/participantManager.js";

type AddonType = "Custom" | "Q&A" | "Poll" | "Quiz";

interface AddonState {
  type: AddonType;
  isActive: boolean;
  data?: unknown;
}

interface GuestRequest {
  participantId: string;
  name: string;
  walletAddress: string;
}

interface RaisedHand {
  participantId: string;
  name: string;
  walletAddress: string;
  timestamp: number;
  userType: "host" | "co-host";
}

interface RoomState {
  currentTime: number;
  executedActions: Set<string>;
  guestRequests: GuestRequest[];
  participants: Set<string>;
}

interface WebSocketMessage<T = unknown> {
  event: string;
  data: T;
}

// Contest Types
type ContestMode = "elimination" | "tournament" | "showcase" | "custom";
type ContestStatus =
  | "idle"
  | "starting"
  | "active"
  | "voting"
  | "ended"
  | "paused"
  | "turn-voting";
type MediaRequirement = "required" | "optional" | "disabled";

interface ContestConfig {
  mode: ContestMode;
  features: {
    timer?: boolean;
    voting?: boolean;
    elimination?: boolean;
    leaderboard?: boolean;
    screenShare?: MediaRequirement;
    camera?: MediaRequirement;
  };
  rules?: {
    maxDuration?: number;
    votingDuration?: number;
    eliminationThreshold?: number;
    roundsCount?: number;
    judgeOnly?: boolean;
    autoAdvanceRounds?: boolean;
    minContestants?: number;
  };
}

interface ContestState {
  roomName: string;
  config: ContestConfig;
  status: ContestStatus;
  currentRound: number;
  startedAt: number;
  contestants: Map<string, ContestantData>;
  judges: Set<string>; // Add this
  pausedRemainingTime?: number;
  eliminated: Set<string>;
  votes: Map<string, Vote[]>;
  votingDeadline: number | null;
  roundResults: RoundResult[];
  timerEndTime: number | null;
}

interface ContestantData {
  participantId: string;
  name: string;
  score: number;
  votes: number;
  isEliminated: boolean;
  eliminatedRound?: number;
}

interface Vote {
  voterId: string;
  targetId: string;
  score: number;
  timestamp: number;
  round: number;
  isRealtime?: boolean; // Indicates if the vote was cast in real-time
  category?: string; // For multi-category voting (e.g., "presentation", "content", "delivery")
  // weight?: number;   // For weighted votes (e.g., judge votes count more)
}

// export interface Vote {
//   voterId: ParticipantId;
//   voterWallet: string;
//   targetId: ParticipantId;
//   score: number;
//   timestamp: number;
//   round: number;
//   category?: string; // For multi-category voting (e.g., "presentation", "content", "delivery")
//   weight?: number;   // For weighted votes (e.g., judge votes count more)
// }

interface RoundResult {
  round: number;
  startedAt: number;
  endedAt: number;
  eliminated: string[];
  leaderboard: LeaderboardEntry[];
}

interface LeaderboardEntry {
  participantId: string;
  name: string;
  score: number;
  votes: number;
  rank: number;
  change: number;
  isEliminated: boolean;
}

interface ContestResults {
  contestId: string;
  winner: string | null;
  finalLeaderboard: LeaderboardEntry[];
  rounds: RoundResult[];
  totalVotes: number;
  duration: number;
}

interface VotingResults {
  round: number;
  votes: Vote[];
  summary: Map<string, { total: number; average: number; count: number }>;
}

// Extend WebSocket to include client-specific properties
interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  roomName?: string;
  participantId?: string;
  connectionId?: string;
  lastActivityTime?: number;
}

// Room and guest request state storage
const roomStates: { [roomName: string]: RoomState } = {};
export const guestRequests: { [roomName: string]: GuestRequest[] } = {};
export const raisedHands: { [roomName: string]: RaisedHand[] } = {};

// Contest state storage
const contestStates: { [roomName: string]: ContestState } = {};
const contestTimers: { [roomName: string]: NodeJS.Timeout } = {};
const votingTimers: { [roomName: string]: NodeJS.Timeout } = {};

// Active addons state
const activeAddons: Record<AddonType, AddonState> = {
  Custom: { type: "Custom", isActive: false },
  "Q&A": { type: "Q&A", isActive: false },
  Poll: { type: "Poll", isActive: false },
  Quiz: { type: "Quiz", isActive: false },
};

export const activeParticipants: {
  [roomName: string]: {
    [participantId: string]: number;
  };
} = {};

// Keep track of connected clients by room and by identity
export const clientsByRoom: { [roomName: string]: Set<ExtendedWebSocket> } = {};
export const clientsByIdentity: { [identity: string]: ExtendedWebSocket } = {};

// Track pending disconnects to handle reconnections
const pendingDisconnects: { [participantId: string]: NodeJS.Timeout } = {};

// Track participant heartbeats for better disconnect detection
const participantHeartbeats: { [participantId: string]: number } = {};

// Grace period settings
// const DISCONNECT_GRACE_PERIOD = 3000; // 3 seconds
// const HEARTBEAT_INTERVAL = 30000; // 30 seconds
// const HEARTBEAT_TIMEOUT = 60000; // 60 seconds - consider participant inactive

const DISCONNECT_GRACE_PERIOD = 10000; // Increase to 10 seconds
const HEARTBEAT_INTERVAL = 25000; // Reduce to 25 seconds
const HEARTBEAT_TIMEOUT = 90000; // Increase to 90 seconds

export let wss: WebSocket.Server;

// Generate unique connection ID
const generateConnectionId = () => {
  return `conn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

function calculateLeaderboard(contest: ContestState): LeaderboardEntry[] {
  const entries: LeaderboardEntry[] = [];
  let rank = 1;

  Array.from(contest.contestants.values())
    .filter((c) => !c.isEliminated)
    .sort((a, b) => {
      // Sort by score first, then by vote count as tiebreaker
      if (b.score === a.score) {
        return b.votes - a.votes;
      }
      return b.score - a.score;
    })
    .forEach((contestant) => {
      entries.push({
        participantId: contestant.participantId,
        name: contestant.name,
        score: contestant.score,
        votes: contestant.votes, // This should now have the correct count
        rank,
        change: 0,
        isEliminated: false,
      });
      rank++;
    });

  return entries;
}

function startRound(
  roomName: string,
  round: number,
  broadcastToRoom: Function
) {
  const contest = contestStates[roomName];
  if (!contest) return;

  contest.currentRound = round;
  contest.status = "active";
  contest.votes.clear(); // Clear votes from previous round

  // Reset vote counts for all contestants
  contest.contestants.forEach((contestant) => {
    contestant.votes = 0;
  });

  const duration = contest.config.rules?.maxDuration || 300;

  // Set timer end time
  contest.timerEndTime = Date.now() + duration * 1000;

  // Broadcast round start
  broadcastToRoom(roomName, "roundStart", { round, duration });

  // Start round timer
  if (contest.config.features?.timer) {
    contestTimers[roomName] = setTimeout(() => {
      // Auto-advance to voting phase
      if (contest.config.features?.voting) {
        startVotingPhase(roomName, broadcastToRoom);
      } else {
        endRound(roomName, broadcastToRoom);
      }
    }, duration * 1000);

    // Send timer updates every second
    const timerInterval = setInterval(() => {
      if (
        !contestStates[roomName] ||
        contestStates[roomName].status === "ended"
      ) {
        clearInterval(timerInterval);
        return;
      }

      const remaining = Math.max(
        0,
        Math.floor((contest.timerEndTime! - Date.now()) / 1000)
      );
      broadcastToRoom(roomName, "timerUpdate", { timeRemaining: remaining });

      if (remaining === 0) {
        clearInterval(timerInterval);
      }
    }, 1000);
  }
}

function startVotingPhase(roomName: string, broadcastToRoom: Function) {
  const contest = contestStates[roomName];
  if (!contest) return;

  contest.status = "voting";
  const votingDuration = contest.config.rules?.votingDuration || 60;
  contest.votingDeadline = Date.now() + votingDuration * 1000;

  broadcastToRoom(roomName, "votingStart", { duration: votingDuration });

  // Set voting timer
  votingTimers[roomName] = setTimeout(() => {
    endVotingPhase(roomName, broadcastToRoom);
  }, votingDuration * 1000);
}

function endVotingPhase(roomName: string, broadcastToRoom: Function) {
  const contest = contestStates[roomName];
  if (!contest) return;

  // Calculate voting results
  const summary = new Map<
    string,
    { total: number; average: number; count: number }
  >();
  contest.votes.forEach((votes, targetId) => {
    const total = votes.reduce((sum, vote) => sum + vote.score, 0);
    const average = votes.length > 0 ? total / votes.length : 0;
    summary.set(targetId, { total, average, count: votes.length });
  });

  const votingResults: VotingResults = {
    round: contest.currentRound,
    votes: Array.from(contest.votes.values()).flat(),
    summary,
  };

  broadcastToRoom(roomName, "votingEnd", { results: votingResults });

  // Process eliminations if enabled
  if (contest.config.features?.elimination) {
    processEliminations(roomName, broadcastToRoom);
  }

  // End the current round
  endRound(roomName, broadcastToRoom);

  // Advance to next round or end contest
  setTimeout(() => {
    if (contest.currentRound < (contest.config.rules?.roundsCount || 3)) {
      // Start next round
      startRound(roomName, contest.currentRound + 1, broadcastToRoom);
    } else {
      // Contest is complete
      contest.status = "ended";

      const finalLeaderboard = calculateLeaderboard(contest);
      const winner = finalLeaderboard[0]?.participantId || null;

      const results = {
        contestId: `${roomName}-${contest.startedAt}`,
        winner,
        finalLeaderboard,
        rounds: contest.roundResults,
        totalVotes: Array.from(contest.votes.values()).flat().length,
        duration: Date.now() - contest.startedAt,
      };

      broadcastToRoom(roomName, "contestEnd", { results });

      // Clean up contest state
      setTimeout(() => {
        delete contestStates[roomName];
      }, 5000);
    }
  }, 2000);
}

function processEliminations(roomName: string, broadcastToRoom: Function) {
  const contest = contestStates[roomName];
  if (!contest) return;

  const threshold = contest.config.rules?.eliminationThreshold || 0.3;
  const activeContestants = Array.from(contest.contestants.values())
    .filter((c) => !c.isEliminated)
    .sort((a, b) => b.score - a.score);

  const eliminateCount = Math.ceil(activeContestants.length * threshold);
  const toEliminate = activeContestants.slice(-eliminateCount);

  toEliminate.forEach((contestant) => {
    contestant.isEliminated = true;
    contestant.eliminatedRound = contest.currentRound;
    contest.eliminated.add(contestant.participantId);
  });

  const eliminatedIds = toEliminate.map((c) => c.participantId);

  if (eliminatedIds.length > 0) {
    broadcastToRoom(roomName, "eliminationUpdate", {
      eliminated: Array.from(contest.eliminated),
    });
  }
}

function endRound(roomName: string, broadcastToRoom: Function) {
  const contest = contestStates[roomName];
  if (!contest) return;

  // Clear timers
  if (contestTimers[roomName]) {
    clearTimeout(contestTimers[roomName]);
    delete contestTimers[roomName];
  }

  // Calculate and store round results
  const leaderboard = calculateLeaderboard(contest);
  const eliminated = Array.from(contest.contestants.values())
    .filter((c) => c.eliminatedRound === contest.currentRound)
    .map((c) => c.participantId);

  const roundResult: RoundResult = {
    round: contest.currentRound,
    startedAt: contest.timerEndTime
      ? contest.timerEndTime - (contest.config.rules?.maxDuration || 300) * 1000
      : Date.now(),
    endedAt: Date.now(),
    eliminated,
    leaderboard,
  };

  contest.roundResults.push(roundResult);

  broadcastToRoom(roomName, "roundEnd", {
    round: contest.currentRound,
    eliminated,
  });
}

/**
 * Creates a WebSocket server
 * @param server HTTP server to attach the WebSocket server to
 * @returns WebSocket server instance
 */
const createWebSocketServer = (server: HttpServer) => {
  wss = new WebSocket.Server({
    server,
    path: "/ws",
  });

  // Set up heartbeat interval to detect disconnected clients
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket) => {
      const extWs = ws as ExtendedWebSocket;
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

    Object.entries(participantHeartbeats).forEach(
      ([participantId, lastSeen]) => {
        if (now - lastSeen > HEARTBEAT_TIMEOUT) {
          console.log(
            `Participant ${participantId} is inactive (no heartbeat for ${HEARTBEAT_TIMEOUT}ms)`
          );

          // Find the client and handle disconnect if they're truly gone
          const client = clientsByIdentity[participantId];
          if (client && client.readyState !== WebSocket.OPEN) {
            handleDisconnect(client, true); // Force immediate disconnect
          }

          delete participantHeartbeats[participantId];
        }
      }
    );
  }, 10000); // Check every 10 seconds

  wss.on("close", () => {
    clearInterval(heartbeatInterval);
    clearInterval(inactivityCheckInterval);
  });

  // Initialize room timer for time synchronization
  const startRoomTimer = (roomName: string) => {
    const interval = setInterval(() => {
      if (roomStates[roomName]) {
        roomStates[roomName].currentTime += 1;
        broadcastToRoom(roomName, "timeSync", roomStates[roomName].currentTime);
      } else {
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
  const broadcastToRoom = <T>(roomName: string, event: string, data: T) => {
    const message = JSON.stringify({ event, data });
    const clients = clientsByRoom[roomName] || new Set();

    // Skip logging for high-frequency events
    const isHighFrequencyEvent = ["ping", "pong", "timeSync"].includes(event);
    if (!isHighFrequencyEvent) {
      console.log(
        `Broadcasting ${event} to ${clients.size} clients in room ${roomName}`
      );
    }

    if (clients.size === 0) {
      if (!isHighFrequencyEvent) {
        console.log(
          `No clients in room ${roomName}. Event ${event} not delivered.`
        );
      }
      return;
    }

    let sentCount = 0;
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          sentCount++;
        } catch (error) {
          console.error(
            `Error broadcasting to client in room ${roomName}:`,
            error
          );
        }
      }
    });

    // Only log successful sends for non-high-frequency events
    if (!isHighFrequencyEvent) {
      console.log(
        `Successfully sent ${event} to ${sentCount}/${clients.size} clients in room ${roomName}`
      );
    }
  };

  /**
   * Sends a message to a specific client by identity
   * @param identity Client identity
   * @param event Event type
   * @param data Event data
   */
  const sendToClient = <T>(identity: string, event: string, data: T) => {
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
  const handleDisconnect = (
    ws: ExtendedWebSocket,
    immediate: boolean = false
  ) => {
    const { roomName, participantId } = ws;

    if (!roomName || !participantId) {
      return;
    }

    console.log(
      `HandleDisconnect called for ${participantId}, immediate: ${immediate}`
    );

    const performDisconnect = () => {
      console.log(
        `Performing disconnect for ${participantId} from room ${roomName}`
      );

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
          const hadRequest = guestRequests[roomName].some(
            (req) => req.participantId === participantId
          );

          guestRequests[roomName] = guestRequests[roomName].filter(
            (req) => req.participantId !== participantId
          );

          if (hadRequest) {
            console.log(
              `Removed request for ${participantId} from room ${roomName}. Remaining requests: ${guestRequests[roomName].length}`
            );

            // Broadcast updated guest requests
            broadcastToRoom(
              roomName,
              "guestRequestsUpdate",
              guestRequests[roomName]
            );
          }
        }

        // Remove participant's raised hand
        if (raisedHands[roomName]) {
          const hadRaisedHand = raisedHands[roomName].some(
            (hand) => hand.participantId === participantId
          );

          if (hadRaisedHand) {
            raisedHands[roomName] = raisedHands[roomName].filter(
              (hand) => hand.participantId !== participantId
            );

            console.log(
              `Removed raised hand for disconnected participant ${participantId}`
            );

            // Broadcast updated raised hands
            broadcastToRoom(
              roomName,
              "raisedHandsUpdate",
              raisedHands[roomName]
            );
          }
        }

        // Broadcast participant left event
        broadcastToRoom(roomName, "participantLeft", { participantId });

        // Clean up empty room state
        if (roomStates[roomName].participants.size === 0) {
          delete roomStates[roomName];
          delete guestRequests[roomName];
          delete raisedHands[roomName];

          // Clean up contest state if exists
          if (contestStates[roomName]) {
            if (contestTimers[roomName]) {
              clearTimeout(contestTimers[roomName]);
              delete contestTimers[roomName];
            }
            if (votingTimers[roomName]) {
              clearTimeout(votingTimers[roomName]);
              delete votingTimers[roomName];
            }
            delete contestStates[roomName];
          }
        }
      }
    };

    if (immediate) {
      performDisconnect();
    } else {
      // Check if there's already a pending disconnect
      if (pendingDisconnects[participantId]) {
        console.log(`Disconnect already pending for ${participantId}`);
        return;
      }

      // Add grace period to handle temporary disconnects
      console.log(
        `Starting ${DISCONNECT_GRACE_PERIOD}ms grace period for ${participantId}`
      );

      pendingDisconnects[participantId] = setTimeout(() => {
        // Check if the participant has reconnected
        const currentClient = clientsByIdentity[participantId];
        if (
          currentClient &&
          currentClient !== ws &&
          currentClient.readyState === WebSocket.OPEN
        ) {
          console.log(
            `Participant ${participantId} reconnected with different connection`
          );
          delete pendingDisconnects[participantId];
          return;
        }

        performDisconnect();
      }, DISCONNECT_GRACE_PERIOD);
    }
  };

  wss.on("connection", (ws: WebSocket) => {
    const extWs = ws as ExtendedWebSocket;
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

    extWs.on("message", (message: WebSocket.Data) => {
      try {
        const { event, data } = JSON.parse(
          message.toString()
        ) as WebSocketMessage;

        // Update last activity time
        extWs.lastActivityTime = Date.now();

        switch (event) {
          case "authenticate": {
            // Handle authentication (check API credentials)
            const { apiKey, apiSecret } = data as {
              apiKey: string;
              apiSecret: string;
            };

            // Simple authentication example - in production, verify these against your database
            if (apiKey && apiSecret) {
              extWs.send(
                JSON.stringify({
                  event: "authResponse",
                  data: { success: true },
                })
              );
            } else {
              extWs.send(
                JSON.stringify({
                  event: "authResponse",
                  data: { success: false, error: "Invalid API credentials" },
                })
              );
            }
            break;
          }

          case "joinRoom": {
            const { roomName, participantId } = data as {
              roomName: string;
              participantId: string;
            };

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
              if (
                existingClient.roomName &&
                clientsByRoom[existingClient.roomName]
              ) {
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

            console.log(
              `Client ${participantId} ${
                isReconnection ? "reconnected to" : "joined"
              } room ${roomName}. Total clients in room: ${
                clientsByRoom[roomName].size
              }`
            );

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
            const isNewParticipant =
              !roomStates[roomName].participants.has(participantId);

            // Add participant to room state
            roomStates[roomName].participants.add(participantId);

            // Send initial sync data
            extWs.send(
              JSON.stringify({
                event: "initialSync",
                data: {
                  currentTime: roomStates[roomName].currentTime,
                  executedActions: Array.from(
                    roomStates[roomName].executedActions
                  ),
                  joinTime: roomStates[roomName].currentTime,
                },
              })
            );

            // Broadcast participant joined ONLY if they're truly new to the room
            if (isNewParticipant && !isReconnection) {
              console.log(
                `Broadcasting participantJoined for ${participantId}`
              );
              broadcastToRoom(roomName, "participantJoined", { participantId });
            } else if (isReconnection) {
              console.log(
                `Skipping participantJoined broadcast for reconnection: ${participantId}`
              );
            }

            // Send current guest requests state to newly joined participant
            setTimeout(() => {
              console.log(
                `Sending existing ${
                  guestRequests[roomName]?.length || 0
                } guest requests to participant ${participantId}`
              );
              if (extWs.readyState === WebSocket.OPEN) {
                extWs.send(
                  JSON.stringify({
                    event: "guestRequestsUpdate",
                    data: guestRequests[roomName] || [],
                  })
                );
              }
            }, 500);

            // Send current raised hands state to newly joined participant
            setTimeout(() => {
              console.log(
                `Sending existing ${
                  raisedHands[roomName]?.length || 0
                } raised hands to participant ${participantId}`
              );
              if (extWs.readyState === WebSocket.OPEN) {
                extWs.send(
                  JSON.stringify({
                    event: "raisedHandsUpdate",
                    data: raisedHands[roomName] || [],
                  })
                );
              }
            }, 600);

            break;
          }

          case "getGuestRequests": {
            const { roomName } = data as { roomName: string };

            if (extWs.participantId) {
              console.log(
                `Received getGuestRequests from ${extWs.participantId} for room ${roomName}`
              );

              // Send the current guest requests directly to the requesting client
              extWs.send(
                JSON.stringify({
                  event: "guestRequestsUpdate",
                  data: guestRequests[roomName] || [],
                })
              );
            }
            break;
          }

          case "getRaisedHands": {
            const { roomName } = data as { roomName: string };

            if (extWs.participantId) {
              console.log(
                `Received getRaisedHands from ${extWs.participantId} for room ${roomName}`
              );

              // Send the current raised hands directly to the requesting client
              extWs.send(
                JSON.stringify({
                  event: "raisedHandsUpdate",
                  data: raisedHands[roomName] || [],
                })
              );
            }
            break;
          }

          case "requestToSpeak": {
            const { participantId, name, roomName, walletAddress } = data as {
              participantId: string;
              name: string;
              roomName: string;
              walletAddress: string;
            };

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
            const existingRequest = guestRequests[roomName].find(
              (req) => req.participantId === participantId
            );

            if (!existingRequest) {
              guestRequests[roomName].push(newRequest);
              console.log(
                `Added request for ${participantId} in room ${roomName}. Total requests: ${guestRequests[roomName].length}`
              );

              // Store requests persistently to be able to send them to newly joined clients
              const clientCount = clientsByRoom[roomName]?.size || 0;
              console.log(
                `Broadcasting guestRequestsUpdate to ${clientCount} clients in room ${roomName}`
              );

              broadcastToRoom(
                roomName,
                "guestRequestsUpdate",
                guestRequests[roomName]
              );

              // If there are no clients in the room, log this fact
              if (
                !clientsByRoom[roomName] ||
                clientsByRoom[roomName].size === 0
              ) {
                console.log(
                  `Warning: No clients in room ${roomName} to receive guest request updates.`
                );
              }
            } else {
              console.log(
                `Request for ${participantId} already exists in room ${roomName}`
              );
            }
            break;
          }

          case "raiseHand": {
            const { participantId, name, roomName, walletAddress } = data as {
              participantId: string;
              name: string;
              roomName: string;
              walletAddress: string;
            };

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
            const existingHand = raisedHands[roomName].find(
              (hand) => hand.participantId === participantId
            );

            if (!existingHand) {
              // Add raised hand
              const newRaisedHand: RaisedHand = {
                participantId,
                name,
                walletAddress,
                timestamp: Date.now(),
                userType: "co-host", // You might want to determine this from participant metadata
              };

              raisedHands[roomName].push(newRaisedHand);
              console.log(
                `Added raised hand for ${participantId} in room ${roomName}. Total raised hands: ${raisedHands[roomName].length}`
              );

              // Broadcast updated raised hands to all clients in the room
              broadcastToRoom(
                roomName,
                "raisedHandsUpdate",
                raisedHands[roomName]
              );
            } else {
              console.log(
                `Hand already raised for ${participantId} in room ${roomName}`
              );
            }
            break;
          }

          case "lowerHand": {
            const { participantId, roomName } = data as {
              participantId: string;
              roomName: string;
            };

            console.log("Received lower hand:", {
              participantId,
              roomName,
            });

            if (raisedHands[roomName]) {
              const initialLength = raisedHands[roomName].length;

              // Remove raised hand
              raisedHands[roomName] = raisedHands[roomName].filter(
                (hand) => hand.participantId !== participantId
              );

              if (raisedHands[roomName].length < initialLength) {
                console.log(
                  `Lowered hand for ${participantId} in room ${roomName}. Remaining raised hands: ${raisedHands[roomName].length}`
                );

                // Broadcast updated raised hands to all clients in the room
                broadcastToRoom(
                  roomName,
                  "raisedHandsUpdate",
                  raisedHands[roomName]
                );
              }
            }
            break;
          }

          case "acknowledgeHand": {
            const { participantId, roomName } = data as {
              participantId: string;
              roomName: string;
            };

            console.log("Host acknowledged raised hand:", {
              participantId,
              roomName,
            });

            if (raisedHands[roomName]) {
              // Remove the acknowledged hand
              raisedHands[roomName] = raisedHands[roomName].filter(
                (hand) => hand.participantId !== participantId
              );

              // Broadcast updated raised hands
              broadcastToRoom(
                roomName,
                "raisedHandsUpdate",
                raisedHands[roomName]
              );

              // Send acknowledgment to the specific participant
              sendToClient(participantId, "handAcknowledged", { roomName });
            }
            break;
          }

          case "inviteGuest": {
            const { participantId, roomName } = data as {
              participantId: string;
              roomName: string;
            };

            console.log(
              `Processing invitation for ${participantId} in room ${roomName}`
            );

            if (guestRequests[roomName]) {
              // Find the participant's request
              const requestIndex = guestRequests[roomName].findIndex(
                (req) => req.participantId === participantId
              );

              if (requestIndex !== -1) {
                // Remove the request from the request list
                const removedRequest = guestRequests[roomName].splice(
                  requestIndex,
                  1
                )[0];

                console.log(
                  `Removed request for ${participantId} from room ${roomName}. Remaining requests: ${guestRequests[roomName].length}`
                );

                // IMPORTANT: Broadcast the updated guest request list FIRST
                broadcastToRoom(
                  roomName,
                  "guestRequestsUpdate",
                  guestRequests[roomName]
                );

                // Small delay to ensure the guestRequestsUpdate is processed first
                setTimeout(() => {
                  // Then broadcast the invitation event to the room
                  broadcastToRoom(roomName, "inviteGuest", {
                    participantId,
                    roomName,
                  });
                }, 100);

                // Log the successful removal for debugging
                console.log(
                  `Successfully processed invitation for ${participantId}:`,
                  {
                    removedRequest,
                    remainingRequests: guestRequests[roomName].length,
                    timestamp: new Date().toISOString(),
                  }
                );
              } else {
                console.warn(
                  `Request for ${participantId} not found in room ${roomName}. Current requests:`,
                  guestRequests[roomName].map((req) => req.participantId)
                );
              }
            } else {
              console.warn(`No guest requests found for room ${roomName}`);
            }
            break;
          }

          case "returnToGuest": {
            const { participantId, roomName } = data as {
              participantId: string;
              roomName: string;
            };

            console.log(
              `Processing return to guest for ${participantId} in room ${roomName}`
            );

            if (guestRequests[roomName]) {
              // Find the participant's request
              const requestIndex = guestRequests[roomName].findIndex(
                (req) => req.participantId === participantId
              );

              if (requestIndex !== -1) {
                // Remove the request from the request list
                guestRequests[roomName].splice(requestIndex, 1);

                console.log(
                  `Removed request for ${participantId} from room ${roomName}. Remaining requests: ${guestRequests[roomName].length}`
                );

                // Broadcast the updated guest request list to all clients in the room
                broadcastToRoom(
                  roomName,
                  "guestRequestsUpdate",
                  guestRequests[roomName]
                );

                // Broadcast the return to guest event to the room
                broadcastToRoom(roomName, "returnToGuest", {
                  participantId,
                  roomName,
                });
              } else {
                console.warn(
                  `Request for ${participantId} not found in room ${roomName}`
                );
              }
            }
            break;
          }

          case "startVoting": {
            const { roomName, duration } = data as {
              roomName: string;
              duration: number;
            };

            const contest = contestStates[roomName];
            if (!contest) {
              console.error(`No contest found for room ${roomName}`);
              break;
            }

            console.log(
              `Starting voting phase for room ${roomName} with ${contest.contestants.size} contestants`
            );

            // ALWAYS send all contestants data with voting start
            const contestantsArray = Array.from(contest.contestants.values());

            broadcastToRoom(roomName, "votingStart", {
              duration,
              contestants: contestantsArray, // Make sure this is always sent
            });

            startVotingPhase(roomName, broadcastToRoom);
            break;
          }
          case "actionExecuted": {
            const { roomName, actionId } = data as {
              roomName: string;
              actionId: string;
            };

            if (roomStates[roomName]) {
              roomStates[roomName].executedActions.add(actionId);
              broadcastToRoom(roomName, "actionExecutedSync", actionId);
            }
            break;
          }

          case "sendReaction": {
            const { roomName, reaction, sender } = data as {
              roomName: string;
              reaction: string;
              sender: unknown;
            };

            // Validate the reaction data
            if (!roomName || !reaction || !sender) {
              console.error("Invalid reaction data received:", {
                roomName,
                reaction,
                sender,
              });
              break;
            }

            // Check if the sender is actually in the room
            if (extWs.roomName !== roomName) {
              console.error(
                `Sender ${extWs.participantId} trying to send reaction to room ${roomName} but is in room ${extWs.roomName}`
              );
              break;
            }

            // Verify room exists
            if (!clientsByRoom[roomName]) {
              console.error(
                `Room ${roomName} does not exist or has no clients`
              );
              break;
            }

            // Add timestamp, ID, and roomName to ensure uniqueness and proper routing
            const reactionData = {
              reaction,
              sender,
              timestamp: Date.now(),
              id: `${reaction}-${
                typeof sender === "string" ? sender : "unknown"
              }-${Date.now()}-${Math.random()}`,
              roomName, // Include roomName in the reaction data
            };

            // console.log(
            //   `Broadcasting reaction from ${
            //     typeof sender === "string" ? sender : "unknown"
            //   } in room ${roomName}`
            // );
            // console.log(
            //   `Room ${roomName} has ${clientsByRoom[roomName].size} connected clients`
            // );

            // Get all clients in the room
            const clients = clientsByRoom[roomName];
            let sentCount = 0;
            let failedCount = 0;
            const clientDetails: string[] = [];

            clients.forEach((client) => {
              const clientInfo = `${
                client.participantId || "unknown"
              } (state: ${client.readyState})`;
              clientDetails.push(clientInfo);

              if (client.readyState === WebSocket.OPEN) {
                try {
                  client.send(
                    JSON.stringify({
                      event: "receiveReaction",
                      data: reactionData,
                    })
                  );
                  sentCount++;
                  // console.log(
                  //   `✓ Sent reaction to client: ${
                  //     client.participantId || "unknown"
                  //   }`
                  // );
                } catch (error) {
                  console.error(
                    `✗ Error sending reaction to client ${client.participantId}:`,
                    error
                  );
                  failedCount++;
                }
              } else {
                console.warn(
                  `✗ Client ${client.participantId} in room ${roomName} has readyState: ${client.readyState}`
                );
                failedCount++;
              }
            });

            // console.log(`Reaction broadcast summary for room ${roomName}:`);
            // console.log(`- Total clients: ${clients.size}`);
            // console.log(`- Successful sends: ${sentCount}`);
            // console.log(`- Failed sends: ${failedCount}`);
            // console.log(`- Client details: ${clientDetails.join(", ")}`);

            // If no clients received the reaction, log a detailed warning
            if (sentCount === 0) {
              console.error(
                `CRITICAL: No clients received the reaction in room ${roomName}!`
              );
              console.error(
                `Room state: ${JSON.stringify({
                  roomExists: !!roomStates[roomName],
                  participantCount:
                    roomStates[roomName]?.participants.size || 0,
                  participants: Array.from(
                    roomStates[roomName]?.participants || []
                  ),
                })}`
              );
            }

            break;
          }

          case "startContest": {
            const {
              roomName,
              config,
              contestants: contestantsList,
            } = data as {
              roomName: string;
              config: ContestConfig;
              contestants: any[]; // Array of contestants from client
            };

            console.log(
              `Starting contest in room ${roomName} with ${
                contestantsList?.length || 0
              } contestants`
            );

            // Initialize contest state with provided contestants
            const contestants = new Map<string, ContestantData>();

            if (contestantsList && contestantsList.length > 0) {
              contestantsList.forEach((contestant) => {
                contestants.set(contestant.participantId, {
                  participantId: contestant.participantId,
                  name: contestant.name,
                  score: 0,
                  votes: 0, // Initialize with 0 votes
                  isEliminated: false,
                });
              });
            }

            contestStates[roomName] = {
              roomName,
              config,
              status: "starting",
              currentRound: 1,
              startedAt: Date.now(),
              contestants,
              judges: new Set(), // Add this
              eliminated: new Set(),
              votes: new Map(),
              votingDeadline: null,
              roundResults: [],
              timerEndTime: null,
            };

            // Broadcast contest start with contestant list to all participants
            broadcastToRoom(roomName, "contestStart", {
              config,
              contestants: Array.from(contestants.values()), // Include contestant list
            });

            setTimeout(() => {
              if (contestStates[roomName]) {
                contestStates[roomName].status = "active";
                startRound(roomName, 1, broadcastToRoom);
              }
            }, 2000);

            break;
          }
          case "endContest": {
            const { roomName } = data as { roomName: string };

            if (!contestStates[roomName]) {
              console.error(`No contest found for room ${roomName}`);
              break;
            }

            const contest = contestStates[roomName];

            // Clear any active timers
            if (contestTimers[roomName]) {
              clearTimeout(contestTimers[roomName]);
              delete contestTimers[roomName];
            }
            if (votingTimers[roomName]) {
              clearTimeout(votingTimers[roomName]);
              delete votingTimers[roomName];
            }

            // Calculate final results
            const finalLeaderboard = calculateLeaderboard(contest);
            const winner = finalLeaderboard[0]?.participantId || null;

            const results: ContestResults = {
              contestId: `${roomName}-${contest.startedAt}`,
              winner,
              finalLeaderboard,
              rounds: contest.roundResults,
              totalVotes: Array.from(contest.votes.values()).flat().length,
              duration: Date.now() - contest.startedAt,
            };

            contest.status = "ended";

            // Broadcast contest end
            broadcastToRoom(roomName, "contestEnd", { results });

            // Clean up contest state after a delay
            setTimeout(() => {
              delete contestStates[roomName];
            }, 5000);

            break;
          }

          case "submitVote": {
            const { roomName, voterId, targetId, score, round, category } =
              data as Vote & { roomName: string };

            const contest = contestStates[roomName];
            if (
              !contest ||
              (contest.status !== "voting" && contest.status !== "turn-voting")
            ) {
              console.error(`Cannot vote - contest not in voting phase`);
              break;
            }

            // Store vote
            const vote: Vote = {
              voterId,
              targetId,
              score,
              timestamp: Date.now(),
              round,
              category,
            };

            const targetVotes = contest.votes.get(targetId) || [];
            contest.votes.set(targetId, [...targetVotes, vote]);

            // Update contestant stats
            const target = contest.contestants.get(targetId);
            if (target) {
              const allVotes = contest.votes.get(targetId) || [];
              const uniqueVoters = new Set(allVotes.map((v) => v.voterId));
              target.votes = uniqueVoters.size;

              const totalScore = allVotes.reduce((sum, v) => sum + v.score, 0);
              target.score =
                allVotes.length > 0 ? totalScore / allVotes.length : 0;
            }

            // Broadcast the vote
            broadcastToRoom(roomName, "voteSubmitted", vote);

            // Broadcast updated contestant data
            broadcastToRoom(roomName, "contestantUpdate", {
              participantId: targetId,
              score: target?.score || 0,
              votes: target?.votes || 0,
            });

            // CRITICAL FIX: Broadcast the actual votes map to sync client state
            const votesArray: Array<{ targetId: string; votes: Vote[] }> = [];
            contest.votes.forEach((votes, targetId) => {
              votesArray.push({ targetId, votes });
            });

            broadcastToRoom(roomName, "votesUpdate", { votes: votesArray });

            // Recalculate and broadcast updated leaderboard
            const leaderboard = calculateLeaderboard(contest);
            broadcastToRoom(roomName, "leaderboardUpdate", leaderboard);

            break;
          }
          case "eliminateContestant": {
            const { roomName, participantId } = data as {
              roomName: string;
              participantId: string;
            };

            const contest = contestStates[roomName];
            if (!contest) break;

            const contestant = contest.contestants.get(participantId);
            if (contestant) {
              contestant.isEliminated = true;
              contestant.eliminatedRound = contest.currentRound;
              contest.eliminated.add(participantId);
            }

            broadcastToRoom(roomName, "participantEliminated", {
              participantId,
              reason: "manual",
            });

            broadcastToRoom(roomName, "eliminationUpdate", {
              eliminated: Array.from(contest.eliminated),
            });

            break;
          }

          case "nextRound": {
            const { roomName } = data as { roomName: string };
            const contest = contestStates[roomName];
            if (!contest || contest.status !== "active") break;

            // Clear any existing timer
            if (contestTimers[roomName]) {
              clearTimeout(contestTimers[roomName]);
              delete contestTimers[roomName];
            }

            // Check if voting is enabled and we should go to voting phase
            if (
              contest.config.features?.voting &&
              contest.status === "active"
            ) {
              // Start voting phase instead of immediately going to next round
              startVotingPhase(roomName, broadcastToRoom);
            } else {
              // No voting, proceed to next round
              endRound(roomName, broadcastToRoom);

              setTimeout(() => {
                if (
                  contest.currentRound <
                  (contest.config.rules?.roundsCount || 3)
                ) {
                  startRound(
                    roomName,
                    contest.currentRound + 1,
                    broadcastToRoom
                  );
                } else {
                  // Contest is over, trigger final voting or end
                  if (contest.config.features?.voting) {
                    startVotingPhase(roomName, broadcastToRoom);
                  } else {
                    // Send endContest through broadcast, not direct to client
                    broadcastToRoom(roomName, "contestEnd", {
                      results: {
                        contestId: `${roomName}-${contest.startedAt}`,
                        winner: null,
                        finalLeaderboard: calculateLeaderboard(contest),
                        rounds: contest.roundResults,
                        totalVotes: 0,
                        duration: Date.now() - contest.startedAt,
                      },
                    });
                  }
                }
              }, 2000);
            }
            break;
          }
          case "getContestState": {
            const { roomName } = data as { roomName: string };

            const contest = contestStates[roomName];
            if (!contest) {
              extWs.send(
                JSON.stringify({
                  event: "contestStateUpdate",
                  data: { state: null },
                })
              );
              break;
            }

            // Filter out any invalid contestants
            const validContestants = Array.from(
              contest.contestants.values()
            ).filter((c) => c && c.participantId && c.name);

            extWs.send(
              JSON.stringify({
                event: "contestStateUpdate",
                data: {
                  state: {
                    status: contest.status,
                    currentRound: contest.currentRound,
                    timeRemaining: contest.timerEndTime
                      ? Math.max(
                          0,
                          Math.floor((contest.timerEndTime - Date.now()) / 1000)
                        )
                      : 0,
                    contestants: validContestants,
                    judges: Array.from(contest.judges),
                    eliminated: Array.from(contest.eliminated),
                    leaderboard: calculateLeaderboard(contest),
                    votingTimeRemaining: contest.votingDeadline
                      ? Math.max(
                          0,
                          Math.floor(
                            (contest.votingDeadline - Date.now()) / 1000
                          )
                        )
                      : 0,
                  },
                },
              })
            );
            break;
          }

          case "setJudges": {
            const { roomName, judges } = data as {
              roomName: string;
              judges: string[];
            };
            const contest = contestStates[roomName];
            if (!contest) {
              console.error(`No contest found for room ${roomName}`);
              break;
            }

            // Update judges set
            contest.judges = new Set(judges);

            console.log(`Updated judges for room ${roomName}:`, judges);

            // Broadcast to all participants
            broadcastToRoom(roomName, "judgesUpdate", { judges });
            break;
          }

          case "pauseContest": {
            const { roomName } = data as { roomName: string };
            const contest = contestStates[roomName];
            if (!contest) break;

            // Store remaining time when pausing
            if (contest.timerEndTime) {
              const remainingTime = Math.max(
                0,
                contest.timerEndTime - Date.now()
              );
              contest.pausedRemainingTime = remainingTime;
            }

            contest.status = "paused";

            // Clear any active timers
            if (contestTimers[roomName]) {
              clearTimeout(contestTimers[roomName]);
              delete contestTimers[roomName];
            }

            // Broadcast pause to ALL participants
            broadcastToRoom(roomName, "contestPaused", {
              remainingTime: contest.pausedRemainingTime || 0,
            });
            break;
          }

          case "resumeContest": {
            const { roomName } = data as { roomName: string };
            const contest = contestStates[roomName];
            if (!contest || contest.status !== "paused") break;

            contest.status = "active";

            // Restore timer with remaining time
            if (contest.pausedRemainingTime) {
              contest.timerEndTime = Date.now() + contest.pausedRemainingTime;

              // Restart the timer
              contestTimers[roomName] = setTimeout(() => {
                if (contest.config.features?.voting) {
                  startVotingPhase(roomName, broadcastToRoom);
                } else {
                  endRound(roomName, broadcastToRoom);
                }
              }, contest.pausedRemainingTime);

              delete contest.pausedRemainingTime;
            }

            // Broadcast resume to ALL participants
            broadcastToRoom(roomName, "contestResumed", {
              timerEndTime: contest.timerEndTime,
            });
            break;
          }

          case "startAddon": {
            const { type, data: addonData } = data as {
              type: AddonType;
              data: unknown;
            };

            activeAddons[type] = {
              type,
              isActive: true,
              data: addonData,
            };

            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(
                  JSON.stringify({
                    event: "addonStateUpdate",
                    data: activeAddons[type],
                  })
                );
              }
            });
            break;
          }

          case "stopAddon": {
            const type = data as AddonType;

            activeAddons[type] = {
              type,
              isActive: false,
              data: null,
            };

            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(
                  JSON.stringify({
                    event: "addonStateUpdate",
                    data: activeAddons[type],
                  })
                );
              }
            });
            break;
          }
          // TURN BASED PLUGIN/ STREAMLINK SERVER CODE
          // case "turnStart":
          case "turnStart": {
            const { roomName, participantId, duration, queue } = data as {
              roomName: string;
              participantId: string;
              duration: number;
              queue: string[];
            };

            const contest = contestStates[roomName];
            if (!contest) {
              console.error(`No contest found for room ${roomName}`);
              break;
            }

            // console.log("=== TURN START DEBUG ===");
            // console.log("Duration received:", duration);
            // console.log("Old timer end time:", contest.timerEndTime);

            // CRITICAL FIX: Always recalculate timerEndTime for this specific turn
            // Ignore any previous timerEndTime value
            const turnDuration = duration; // Should be 120
            const endTime = Date.now() + turnDuration * 1000;

            // console.log("New timer end time:", endTime);
            // console.log("Should end in (ms):", endTime - Date.now());
            // console.log("========================");

            // IMPORTANT: Overwrite any existing timerEndTime
            contest.timerEndTime = endTime;
            contest.status = "active";

            broadcastToRoom(roomName, "turnStart", {
              participantId,
              duration: turnDuration,
              queue,
              currentPerformer: participantId,
            });

            break;
          }
          case "turnSkipped":
          case "turnTimeout":
          case "allTurnsComplete":
          case "turnBasedReady": {
            // Relay turn-based events to all participants
            const { roomName, ...eventData } = data as any;
            console.log(
              `Broadcasting ${event} to room ${roomName}:`,
              eventData
            );
            broadcastToRoom(roomName, event, eventData);
            break;
          }

          // Add this to your WebSocket server message handler
          // Replace the existing "turnEnd" case with this:

          case "turnEnd": {
            const { roomName, participantId, triggerVoting } = data as {
              roomName: string;
              participantId: string;
              triggerVoting?: boolean;
            };

            // Broadcast turn end
            broadcastToRoom(roomName, "turnEnd", { participantId });

            // If triggerVoting is true, automatically start turn-based voting
            if (triggerVoting && contestStates[roomName]) {
              // Small delay before starting voting
              setTimeout(() => {
                const contest = contestStates[roomName];
                if (!contest) return;

                // Start turn voting phase
                const votingDuration = 30; // You can make this configurable
                contest.status = "turn-voting";
                contest.votingDeadline = Date.now() + votingDuration * 1000;

                console.log(
                  `Auto-starting turn voting for ${participantId} (${votingDuration}s)`
                );

                // Get performer info
                const performer = contest.contestants.get(participantId);

                // Broadcast turn voting start
                broadcastToRoom(roomName, "turnVotingStart", {
                  performerId: participantId,
                  performerName: performer?.name || "Unknown",
                  duration: votingDuration,
                  contestants: performer ? [performer] : [],
                });

                // Set timer to end turn voting
                votingTimers[roomName] = setTimeout(() => {
                  // Calculate results for this performer
                  const votes = contest.votes.get(participantId) || [];
                  const totalScore = votes.reduce(
                    (sum, vote) => sum + vote.score,
                    0
                  );
                  const averageScore =
                    votes.length > 0 ? totalScore / votes.length : 0;

                  // Update contestant score
                  const contestant = contest.contestants.get(participantId);
                  if (contestant) {
                    contestant.score = averageScore;
                    contestant.votes = votes.length;
                  }

                  // Broadcast turn voting end
                  broadcastToRoom(roomName, "turnVotingEnd", {
                    performerId: participantId,
                    score: averageScore,
                    voteCount: votes.length,
                  });

                  // Reset status
                  contest.status = "active";
                  contest.votingDeadline = null;

                  // Clear the timer
                  if (votingTimers[roomName]) {
                    clearTimeout(votingTimers[roomName]);
                    delete votingTimers[roomName];
                  }
                }, votingDuration * 1000);
              }, 1000); // 1 second delay
            }

            break;
          }
          case "updateContestConfig": {
            const { config, contestType, contestReady } = data as {
              config: any; // Your ContestConfig type
              contestType: "simultaneous" | "turn-based";
              contestReady: boolean;
            };

            const { roomName } = data as { roomName: string };

            console.log(
              `Host updating contest config for room ${roomName} to ${contestType} mode`
            );

            // Broadcast config update to all participants except sender
            broadcastToRoom(roomName, "contestConfigUpdate", {
              config,
              contestType,
              contestReady,
            });

            break;
          }

          case "startTurnVoting": {
            const { roomName, performerId, duration } = data as {
              roomName: string;
              performerId: string;
              duration: number;
            };

            const contest = contestStates[roomName];
            if (!contest) {
              console.error(`No contest found for room ${roomName}`);
              break;
            }

            // Start turn voting phase
            const votingDuration = duration || 30;
            contest.status = "turn-voting";
            contest.votingDeadline = Date.now() + votingDuration * 1000;

            // console.log(
            //   `Starting turn voting for ${performerId} (${votingDuration}s)`
            // );

            // Get performer info
            const performer = contest.contestants.get(performerId);

            broadcastToRoom(roomName, "turnVotingStart", {
              performerId: performerId,
              performerName: performer?.name || "Unknown",
              duration: votingDuration,
              // Don't send contestants - clients already have them from contest start
            });

            // Set timer to end turn voting
            votingTimers[roomName] = setTimeout(() => {
              // Calculate results for this performer
              const votes = contest.votes.get(performerId) || [];
              const totalScore = votes.reduce(
                (sum, vote) => sum + vote.score,
                0
              );
              const averageScore =
                votes.length > 0 ? totalScore / votes.length : 0;

              // Update contestant score
              const contestant = contest.contestants.get(performerId);
              if (contestant) {
                contestant.score = averageScore;
                const uniqueVoters = new Set(votes.map((v) => v.voterId));
                contestant.votes = uniqueVoters.size;
              }

              // Broadcast votes update so clients have the latest votes
              const votesArray: Array<{ targetId: string; votes: Vote[] }> = [];
              contest.votes.forEach((votes, targetId) => {
                votesArray.push({ targetId, votes });
              });
              broadcastToRoom(roomName, "votesUpdate", { votes: votesArray });

              // Broadcast updated leaderboard
              const leaderboard = calculateLeaderboard(contest);
              broadcastToRoom(roomName, "leaderboardUpdate", leaderboard);

              // Broadcast turn voting end
              broadcastToRoom(roomName, "turnVotingEnd", {
                performerId: performerId,
                score: averageScore,
                voteCount: votes.length,
              });

              // Reset status
              contest.status = "active";
              contest.votingDeadline = null;

              // Clear the timer
              if (votingTimers[roomName]) {
                clearTimeout(votingTimers[roomName]);
                delete votingTimers[roomName];
              }
            }, votingDuration * 1000);

            break;
          }

          case "submitRealtimeVote": {
            const { roomName, voterId, targetId, score, round, category } =
              data as {
                roomName: string;
                voterId: string;
                targetId: string;
                score: number;
                round: number;
                category?: string;
              };

            const contest = contestStates[roomName];
            if (!contest) {
              console.error(`No contest found for room ${roomName}`);
              break;
            }

            // Store the real-time vote
            const vote: Vote = {
              voterId,
              targetId,
              score,
              timestamp: Date.now(),
              round,
              category,
              isRealtime: true,
            };

            const targetVotes = contest.votes.get(targetId) || [];
            contest.votes.set(targetId, [...targetVotes, vote]);

            // Update contestant stats immediately
            const target = contest.contestants.get(targetId);
            if (target) {
              const allVotes = contest.votes.get(targetId) || [];

              const uniqueVoters = new Set(allVotes.map((v) => v.voterId));
              target.votes = uniqueVoters.size;

              const totalScore = allVotes.reduce((sum, v) => sum + v.score, 0);
              target.score =
                allVotes.length > 0 ? totalScore / allVotes.length : 0;
            }

            // Broadcast the real-time vote
            broadcastToRoom(roomName, "realtimeVoteSubmitted", {
              vote,
              updatedScore: target?.score || 0,
              voteCount: target?.votes || 0,
            });

            const votesArray: Array<{ targetId: string; votes: Vote[] }> = [];
            contest.votes.forEach((votes, targetId) => {
              votesArray.push({ targetId, votes });
            });

            broadcastToRoom(roomName, "votesUpdate", { votes: votesArray });

            // Recalculate and broadcast leaderboard
            const leaderboard = calculateLeaderboard(contest);
            broadcastToRoom(roomName, "leaderboardUpdate", leaderboard);

            break;
          }

          case "pauseTurn": {
            const { roomName } = data as { roomName: string };

            const contest = contestStates[roomName];
            if (!contest || contest.status !== "active") {
              console.error(`Cannot pause turn - contest not active`);
              break;
            }

            // Calculate remaining time
            const currentTime = Date.now();
            const elapsed = contest.timerEndTime
              ? Math.max(0, contest.timerEndTime - currentTime)
              : 0;
            const remainingMs = contest.timerEndTime
              ? Math.max(0, contest.timerEndTime - currentTime)
              : 0;
            const remainingSeconds = Math.floor(remainingMs / 1000);

            // console.log("Calculated remaining (ms):", remainingMs);
            console.log("Calculated remaining (seconds):", remainingSeconds);
            // console.log("==========================");

            // Store the remaining time
            contest.pausedRemainingTime = elapsed;
            contest.status = "paused";

            console.log(`Turn paused with ${elapsed}ms remaining`);

            // Broadcast pause event
            broadcastToRoom(roomName, "turnPaused", {
              remainingTime: elapsed,
            });

            break;
          }

          case "resumeTurn": {
            const { roomName } = data as { roomName: string };

            const contest = contestStates[roomName];
            if (!contest || contest.status !== "paused") {
              console.error(`Cannot resume turn - contest not paused`);
              break;
            }

            // Calculate new end time based on remaining time
            const newEndTime = Date.now() + (contest.pausedRemainingTime || 0);
            contest.timerEndTime = newEndTime;
            contest.status = "active";
            delete contest.pausedRemainingTime;

            console.log(
              `Turn resumed with ${
                contest.timerEndTime - Date.now()
              }ms remaining`
            );

            // Broadcast resume event
            broadcastToRoom(roomName, "turnResumed", {
              timerEndTime: contest.timerEndTime,
            });

            break;
          }

          case "restartTurn": {
            const { roomName, performerId, duration } = data as {
              roomName: string;
              performerId: string;
              duration?: number;
            };

            const contest = contestStates[roomName];
            if (!contest) {
              console.error(`Cannot restart turn - contest not found`);
              break;
            }

            // Use provided duration or default turn duration
            const turnDuration = duration || 120; // Default 2 minutes
            const newEndTime = Date.now() + turnDuration * 1000;

            contest.timerEndTime = newEndTime;
            contest.status = "active";
            delete contest.pausedRemainingTime;

            console.log(
              `Turn restarted for ${performerId} with ${turnDuration}s`
            );

            // Broadcast restart event
            broadcastToRoom(roomName, "turnRestarted", {
              performerId,
              duration: turnDuration,
              timerEndTime: newEndTime,
            });

            break;
          }
          // TURN BASED PLUGIN/ STREAMLINK SERVER CODE

          case "participantActive": {
            const { participantId, roomName, timestamp } = data as {
              participantId: string;
              roomName: string;
              timestamp: number;
            };

            // Update heartbeat
            participantHeartbeats[participantId] = Date.now();

            // Use the centralized manager
            ParticipantManager.updateParticipantActivity(
              roomName,
              participantId
            );
            console.log(
              `Participant ${participantId} active in room ${roomName}`
            );
            break;
          }

          case "newToken": {
            const { participantId, token, newUserType } = data as {
              participantId: string;
              token: string;
              newUserType: "host" | "co-host" | "temp-host" | "guest";
            };

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
      } catch (error) {
        console.error("Error handling WebSocket message:", error);
      }
    });

    extWs.on("close", (code, reason) => {
      console.log(`WebSocket connection closed:`, {
        connectionId: extWs.connectionId,
        participantId: extWs.participantId,
        code,
        reason: reason ? reason.toString() : "No reason provided",
        wasClean: code === 1000 || code === 1001,
        lastActivity: extWs.lastActivityTime
          ? new Date(extWs.lastActivityTime).toISOString()
          : "Unknown",
        timestamp: new Date().toISOString(),
      });
      handleDisconnect(extWs);
    });

    extWs.on("error", (error) => {
      console.error("WebSocket error 1:", error);
      console.error("WebSocket error 2:", {
        connectionId: extWs.connectionId,
        participantId: extWs.participantId,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
      handleDisconnect(extWs, true); // Immediate disconnect on error
    });
  });

  return wss;
};

export default createWebSocketServer;
