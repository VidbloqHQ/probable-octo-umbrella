import { AccessToken, EgressClient, EncodedFileOutput, StreamOutput, StreamProtocol, } from "livekit-server-sdk";
import { StreamSessionType, CallType, StreamFundingType } from "@prisma/client";
import { db, executeQuery, trackQuery } from "../prisma.js";
import { generateMeetingLink, isValidWalletAddress, roomService, livekitHost, checkAndStoreIdempotency, generateIdempotencyKey, } from "../utils/index.js";
// Cache for stream lookups
const streamCache = new Map();
const STREAM_CACHE_TTL = 30000; // 30 seconds
// Cache for tenant configuration
const tenantConfigCache = new Map();
const TENANT_CONFIG_CACHE_TTL = 300000; // 5 minutes
/**
 * Helper function to generate a unique stream name - FIXED
 */
async function generateUniqueStreamName(tenantId) {
    // Try up to 5 times
    for (let attempt = 0; attempt < 5; attempt++) {
        const streamName = generateMeetingLink();
        // Simply check if name exists - don't create a temporary stream
        const existingStream = await executeQuery(() => db.stream.findFirst({
            where: {
                name: streamName,
                tenantId: tenantId,
            },
            select: { id: true }
        }), { maxRetries: 1, timeout: 2000 });
        if (!existingStream) {
            // Name is available
            return streamName;
        }
        // Name taken, try again
        console.log(`Stream name ${streamName} already exists, trying again...`);
    }
    // Fallback with timestamp to ensure uniqueness
    return `${generateMeetingLink()}-${Date.now()}`;
}
/**
 * Helper function to get enabled stream types for a tenant
 */
function getEnabledStreamTypes(tenant, defaultTypes = null) {
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
async function getTenantConfig(tenantId) {
    const cached = tenantConfigCache.get(tenantId);
    if (cached && Date.now() - cached.timestamp < TENANT_CONFIG_CACHE_TTL) {
        return cached.data;
    }
    const tenantWithDetails = await executeQuery(() => db.tenant.findUnique({
        where: { id: tenantId },
        include: { enabledStreamTypes: true },
    }), { maxRetries: 1, timeout: 3000 });
    if (tenantWithDetails) {
        tenantConfigCache.set(tenantId, {
            data: tenantWithDetails,
            timestamp: Date.now()
        });
    }
    return tenantWithDetails;
}
/**
 * Controller for creating a stream - FIXED WITH ABORT CHECKING
 */
export const createStream = async (req, res) => {
    const { wallet, callType = "video", scheduledFor, title, streamSessionType, fundingType, isPublic = true, } = req.body;
    const tenant = req.tenant;
    let success = false;
    try {
        const abortController = req.abortController;
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!wallet || !isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Valid wallet address required." });
        }
        // Generate idempotency key
        const idempotencyKey = generateIdempotencyKey('createStream', tenant.id, wallet, title || 'untitled', Date.now().toString());
        // Check idempotency with timeout
        const { cached, result } = await Promise.race([
            checkAndStoreIdempotency(idempotencyKey, async () => {
                // Step 1: Upsert user (atomic operation)
                const user = await executeQuery(() => db.user.upsert({
                    where: {
                        walletAddress_tenantId: {
                            walletAddress: wallet,
                            tenantId: tenant.id
                        }
                    },
                    update: {}, // No update needed
                    create: {
                        walletAddress: wallet,
                        tenantId: tenant.id,
                        points: 0
                    }
                }), { maxRetries: 1, timeout: 2000 });
                // Step 2: Generate unique stream name
                const streamName = await generateUniqueStreamName(tenant.id);
                // Step 3: Create stream (single atomic operation)
                const stream = await executeQuery(() => db.stream.create({
                    data: {
                        name: streamName,
                        title,
                        callType: callType === 'audio' ? 'Audio' : 'Video',
                        creatorWallet: wallet,
                        streamSessionType: streamSessionType || tenant.defaultStreamType,
                        fundingType: fundingType || tenant.defaultFundingType,
                        isPublic,
                        scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
                        tenantId: tenant.id,
                        userId: user.id,
                        hasHost: false,
                        recording: false,
                        isLive: false
                    }
                }), { maxRetries: 1, timeout: 3000 });
                // Step 4: Create LiveKit room (can fail without affecting DB)
                try {
                    await roomService.createRoom({
                        name: streamName,
                        emptyTimeout: 300,
                        maxParticipants: 100,
                    });
                }
                catch (error) {
                    console.error(`LiveKit room creation failed for ${streamName}:`, error);
                    // Continue - room will be created on first join if needed
                }
                return stream;
            }),
            new Promise((resolve) => setTimeout(() => resolve({ cached: false, result: null }), 10000))
        ]);
        if (!result) {
            return res.status(504).json({
                error: "Request timeout",
                message: "Stream creation took too long. Please try again."
            });
        }
        if (cached) {
            console.log(`Returned cached result for idempotency key: ${idempotencyKey}`);
        }
        success = true;
        if (!res.headersSent && !abortController?.signal?.aborted) {
            return res.status(201).json(result);
        }
    }
    catch (error) {
        console.error("Error creating stream:", error);
        if (res.headersSent)
            return;
        if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
            return res.status(504).json({
                error: "Database query timeout",
                message: "The operation took too long. Please try again."
            });
        }
        return res.status(500).json({ error: "Internal server error" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for creating access token - FIXED WITH ABORT CHECKING
 */
// export const createStreamToken = async (req: TenantRequest, res: Response) => {
//   const { roomName, userName, wallet, avatarUrl } = req.body;
//   const tenant = req.tenant;
//   let success = false;
//   try {
//     const abortController = (req as any).abortController;
//     if (res.headersSent || abortController?.signal?.aborted) {
//       return;
//     }
//     if (!tenant) {
//       return res.status(401).json({ error: "Tenant authentication required." });
//     }
//     if (!roomName || !userName || !wallet || !isValidWalletAddress(wallet)) {
//       return res.status(400).json({
//         error: "Missing or invalid required fields",
//       });
//     }
//     // Step 1: Get stream (with caching and timeout)
//     const cacheKey = `${tenant.id}:${roomName}`;
//     let existingStream = streamCache.get(cacheKey)?.data;
//     if (!existingStream || Date.now() - streamCache.get(cacheKey)!.timestamp > STREAM_CACHE_TTL) {
//       existingStream = await executeQuery(
//         () => db.stream.findFirst({
//           where: {
//             name: roomName,
//             tenantId: tenant.id,
//           },
//           include: { user: true },
//         }),
//         { maxRetries: 1, timeout: 2000 }
//       );
//       if (!existingStream) {
//         return res.status(404).json({ error: "Stream not found" });
//       }
//       streamCache.set(cacheKey, { data: existingStream, timestamp: Date.now() });
//     }
//     // Check abort before continuing
//     if (res.headersSent || abortController?.signal?.aborted) {
//       return;
//     }
//     // Step 2: Upsert user (atomic) with timeout
//     const user = await executeQuery(
//       () => db.user.upsert({
//         where: {
//           walletAddress_tenantId: {
//             walletAddress: wallet,
//             tenantId: tenant.id
//           }
//         },
//         update: {}, // No update needed
//         create: {
//           walletAddress: wallet,
//           tenantId: tenant.id,
//           points: 0
//         }
//       }),
//       { maxRetries: 1, timeout: 2000 }
//     );
//     // Step 3: Determine userType
//     let userType: "host" | "co-host" | "guest";
//     if (user.id === existingStream.userId) {
//       userType = "host";
//     } else if (existingStream.streamSessionType === StreamSessionType.Meeting) {
//       userType = "co-host";
//     } else {
//       userType = "guest";
//     }
//     // Step 4: Check access permissions
//     if (!existingStream.isPublic && userType === "guest") {
//       return res.status(403).json({ error: "This stream requires permission to join" });
//     }
//     if (userType === "guest" && !existingStream.hasHost) {
//       return res.status(403).json({ error: "Waiting for host to join" });
//     }
//     // Step 5: Upsert participant (atomic) with timeout
//     const participant = await executeQuery(
//       () => db.participant.upsert({
//         where: {
//           walletAddress_streamId_tenantId: {
//             walletAddress: wallet,
//             streamId: existingStream.id,
//             tenantId: tenant.id
//           }
//         },
//         update: {
//           userName,
//           userType,
//           leftAt: null, // Mark as rejoined
//           version: { increment: 1 },
//           ...(avatarUrl && { avatarUrl })
//         },
//         create: {
//           userName,
//           walletAddress: wallet,
//           userType,
//           streamId: existingStream.id,
//           tenantId: tenant.id,
//           totalPoints: 0,
//           ...(avatarUrl && { avatarUrl })
//         }
//       }),
//       { maxRetries: 1, timeout: 3000 }
//     );
//     // Step 6: Update stream if host joins (separate operation, can retry)
//     if (userType === "host" && !existingStream.hasHost) {
//       // Fire and forget - don't wait
//       executeQuery(
//         () => db.stream.updateMany({
//           where: { 
//             id: existingStream.id,
//             hasHost: false // Only update if still false
//           },
//           data: {
//             hasHost: true,
//             isLive: true,
//             startedAt: existingStream.startedAt || new Date(),
//             version: { increment: 1 }
//           },
//         }),
//         { maxRetries: 2, timeout: 3000 }
//       ).catch(err => {
//         console.error(`Failed to update stream status: ${err.message}`);
//         // Non-critical - stream will function anyway
//       });
//       // Invalidate cache
//       streamCache.delete(cacheKey);
//     }
//     // Step 7: Generate token
//     const accessToken = new AccessToken(
//       process.env.LIVEKIT_API_KEY!,
//       process.env.LIVEKIT_API_SECRET!,
//       {
//         identity: participant.id,
//         ttl: "60m",
//         metadata: JSON.stringify({
//           userName,
//           participantId: participant.id,
//           userType,
//           walletAddress: wallet,
//           ...(avatarUrl && { avatarUrl }),
//         }),
//       }
//     );
//     accessToken.addGrant({
//       roomJoin: true,
//       room: roomName,
//       canPublish: userType === "host" || userType === "co-host",
//       canSubscribe: true,
//       canPublishData: true,
//       roomRecord: userType === "host" || userType === "co-host",
//     });
//     const token = await accessToken.toJwt();
//     success = true;
//     if (!res.headersSent && !abortController?.signal?.aborted) {
//       return res.status(200).json({ token, userType });
//     }
//   } catch (error: any) {
//     console.error("Error creating token:", error);
//     if (res.headersSent) return;
//     if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
//       return res.status(504).json({ 
//         error: "Database query timeout",
//         message: "The operation took too long. Please try again."
//       });
//     }
//     if (error.message?.includes("permission") || error.message?.includes("Waiting for host")) {
//       return res.status(403).json({ error: error.message });
//     }
//     return res.status(500).json({ error: "Internal server error" });
//   } finally {
//     trackQuery(success);
//   }
// };
export const createStreamToken = async (req, res) => {
    const { roomName, userName, wallet, avatarUrl } = req.body;
    const tenant = req.tenant;
    try {
        // Check abort signal
        const abortController = req.abortController;
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
        // Validation
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!roomName || !userName || !wallet || !isValidWalletAddress(wallet)) {
            return res.status(400).json({
                error: "Missing or invalid required fields",
            });
        }
        // CRITICAL OPTIMIZATION: Parallel fetch with smaller timeout
        const [streamData, user] = await Promise.all([
            executeQuery(() => db.stream.findFirst({
                where: { name: roomName, tenantId: tenant.id },
                select: {
                    id: true,
                    userId: true,
                    streamSessionType: true,
                    isPublic: true,
                    hasHost: true,
                    startedAt: true
                }
            }), { maxRetries: 1, timeout: 2000 } // Reduced timeout
            ),
            executeQuery(() => db.user.upsert({
                where: {
                    walletAddress_tenantId: {
                        walletAddress: wallet,
                        tenantId: tenant.id
                    }
                },
                update: {},
                create: {
                    walletAddress: wallet,
                    tenantId: tenant.id,
                    points: 0
                }
            }), { maxRetries: 1, timeout: 2000 } // Reduced timeout
            )
        ]);
        if (!streamData) {
            return res.status(404).json({ error: "Stream not found" });
        }
        // Determine user type
        const userType = user.id === streamData.userId ? "host" :
            streamData.streamSessionType === StreamSessionType.Meeting ? "co-host" :
                "guest";
        // Access checks
        if (!streamData.isPublic && userType === "guest") {
            return res.status(403).json({ error: "This stream requires permission to join" });
        }
        if (userType === "guest" && !streamData.hasHost) {
            return res.status(403).json({ error: "Waiting for host to join" });
        }
        // Upsert participant
        const participant = await executeQuery(() => db.participant.upsert({
            where: {
                walletAddress_streamId_tenantId: {
                    walletAddress: wallet,
                    streamId: streamData.id,
                    tenantId: tenant.id
                }
            },
            update: {
                userName,
                userType,
                leftAt: null,
                version: { increment: 1 },
                ...(avatarUrl && { avatarUrl })
            },
            create: {
                userName,
                walletAddress: wallet,
                userType,
                streamId: streamData.id,
                tenantId: tenant.id,
                totalPoints: 0,
                ...(avatarUrl && { avatarUrl })
            }
        }), { maxRetries: 1, timeout: 2000 });
        if (!participant) {
            return res.status(500).json({ error: "Failed to create/update participant" });
        }
        // Update stream status asynchronously if host (don't wait)
        if (userType === "host" && !streamData.hasHost) {
            executeQuery(() => db.stream.update({
                where: { id: streamData.id },
                data: {
                    hasHost: true,
                    isLive: true,
                    startedAt: streamData.startedAt || new Date()
                }
            }), { maxRetries: 1, timeout: 2000 }).catch(err => console.log('Non-critical: Stream status update failed'));
        }
        // Generate token
        const accessToken = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
            identity: participant.id,
            ttl: "60m",
            metadata: JSON.stringify({
                userName,
                participantId: participant.id,
                userType,
                walletAddress: wallet,
                ...(avatarUrl && { avatarUrl }),
            }),
        });
        accessToken.addGrant({
            roomJoin: true,
            room: roomName,
            canPublish: userType === "host" || userType === "co-host",
            canSubscribe: true,
            canPublishData: true,
            roomRecord: userType === "host" || userType === "co-host",
        });
        const token = await accessToken.toJwt();
        return res.status(200).json({ token, userType });
    }
    catch (error) {
        console.error("Error creating token:", error);
        if (res.headersSent)
            return;
        if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
            return res.status(504).json({
                error: "Database query timeout",
                message: "The operation took too long. Please try again."
            });
        }
        return res.status(500).json({ error: "Internal server error" });
    }
};
/**
 * Controller for getting stream details - FIXED WITH SINGLE RESPONSE
 */
export const getStream = async (req, res) => {
    // Guard: Check if response already sent at the very beginning
    if (res.headersSent) {
        console.log(`[getStream] Response already sent at start`);
        return;
    }
    const { streamId } = req.params;
    const tenant = req.tenant;
    let success = false;
    try {
        const abortController = req.abortController;
        if (abortController?.signal?.aborted) {
            console.log(`[getStream] Request already aborted for ${streamId}`);
            return;
        }
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." }); // CRITICAL: Return immediately after sending response
        }
        if (!streamId) {
            return res.status(400).json({ error: "Missing stream ID." }); // CRITICAL: Return immediately after sending response
        }
        // Check cache first
        const cacheKey = `${tenant.id}:${streamId}:full`;
        const cached = streamCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < STREAM_CACHE_TTL) {
            success = true;
            return res.status(200).json(cached.data);
        }
        // Check before query
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
        // Query with timeout and limited results
        const stream = await executeQuery(() => db.stream.findFirst({
            where: {
                name: streamId,
                tenantId: tenant.id,
            },
            include: {
                agenda: {
                    include: {
                        pollContent: true,
                        quizContent: {
                            include: {
                                questions: {
                                    take: 20 // Limit questions
                                }
                            },
                        },
                        qaContent: true,
                        customContent: true,
                    },
                    take: 50 // Limit agendas
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
                    },
                    take: 100 // Limit participants
                },
            },
        }), { maxRetries: 1, timeout: 3000 } // Reduced from 5000
        );
        // Check again after query
        if (res.headersSent || abortController?.signal?.aborted) {
            console.log(`[getStream] Response sent/aborted while querying for ${streamId}`);
            return;
        }
        if (!stream) {
            return res.status(404).json({ error: "Stream not found." }); // CRITICAL: Return immediately after sending response
        }
        // Cache the result
        streamCache.set(cacheKey, { data: stream, timestamp: Date.now() });
        success = true;
        // Final check before sending (belt and suspenders)
        if (res.headersSent) {
            console.log(`[getStream] Response already sent before final send`);
            return;
        }
        return res.status(200).json(stream); // CRITICAL: Return immediately after sending response
    }
    catch (error) {
        console.error("Error fetching stream:", error);
        // Check before sending error response
        if (res.headersSent) {
            console.log(`[getStream] Error after response sent for ${req.params.streamId}`);
            return;
        }
        if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
            return res.status(504).json({
                error: "Database query timeout",
                message: "The request took too long. Please try again."
            });
        }
        return res.status(500).json({ error: "Internal server error" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for recording stream - OPTIMIZED
 */
export const recordStream = async (req, res) => {
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
            executeQuery(() => db.stream.findFirst({
                where: {
                    name: roomName,
                    tenantId: tenant.id,
                },
                include: {
                    user: true,
                },
            }), { maxRetries: 2, timeout: 10000 }),
            executeQuery(() => db.user.findFirst({
                where: {
                    walletAddress: wallet,
                    tenantId: tenant.id,
                },
            }), { maxRetries: 2, timeout: 10000 })
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
        let userType;
        if (user.id === stream.userId) {
            userType = "host";
        }
        else if (stream.streamSessionType === StreamSessionType.Meeting) {
            userType = "co-host";
        }
        else {
            userType = "guest";
        }
        if (userType !== "host" && userType !== "co-host") {
            return res.status(403).json({
                error: "Only hosts and co-hosts can record streams.",
            });
        }
        // Start recording
        const egressService = new EgressClient(livekitHost, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
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
        const egressInfo = await egressService.startRoomCompositeEgress(roomName, output);
        if (!egressInfo) {
            return res
                .status(500)
                .json({ error: "Failed to start recording. Please try again" });
        }
        await executeQuery(() => db.stream.update({
            where: { id: stream.id },
            data: {
                recording: true,
                recordId: egressInfo.egressId,
            },
        }), { maxRetries: 2, timeout: 10000 });
        // Invalidate cache
        streamCache.delete(`${tenant.id}:${roomName}`);
        success = true;
        return res.status(201).json({
            message: "Recording started",
            recordingId: egressInfo.egressId,
            streamId: stream.id,
        });
    }
    catch (error) {
        console.error("Error starting recording:", error);
        return res.status(500).json({
            error: "Internal server error",
            details: error instanceof Error ? error.message : String(error),
        });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for stopping stream recording - OPTIMIZED
 */
export const stopStreamRecord = async (req, res) => {
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
            executeQuery(() => db.stream.findFirst({
                where: {
                    recordId,
                    tenantId: tenant.id,
                    recording: true,
                },
                include: {
                    user: true,
                },
            }), { maxRetries: 2, timeout: 10000 }),
            executeQuery(() => db.user.findFirst({
                where: {
                    walletAddress: wallet,
                    tenantId: tenant.id,
                },
            }), { maxRetries: 2, timeout: 10000 })
        ]);
        if (!stream) {
            return res.status(404).json({ error: "Active recording not found" });
        }
        if (!user) {
            return res.status(403).json({ error: "User not found" });
        }
        let userType;
        if (user.id === stream.userId) {
            userType = "host";
        }
        else if (stream.streamSessionType === StreamSessionType.Meeting) {
            userType = "co-host";
        }
        else {
            userType = "guest";
        }
        if (userType !== "host" && userType !== "co-host") {
            return res.status(403).json({
                error: "Only hosts and co-hosts can stop recordings.",
            });
        }
        const egressService = new EgressClient(livekitHost, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
        await egressService.stopEgress(recordId);
        await executeQuery(() => db.stream.update({
            where: { id: stream.id },
            data: {
                recording: false,
            },
        }), { maxRetries: 2, timeout: 10000 });
        // Invalidate cache
        streamCache.delete(`${tenant.id}:${stream.name}`);
        success = true;
        return res.status(200).json({
            message: "Recording stopped successfully",
            streamId: stream.id,
            recordId: recordId,
        });
    }
    catch (error) {
        console.error("Error stopping recording:", error);
        return res.status(500).json({
            error: "Internal server error",
            details: error instanceof Error ? error.message : String(error),
        });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for updating stream - OPTIMIZED WITH ABORT CHECKING
 */
export const updateStream = async (req, res) => {
    const { streamId } = req.params;
    const { scheduledFor, title, callType, streamSessionType, fundingType, isPublic, wallet, } = req.body;
    const tenant = req.tenant;
    let success = false;
    try {
        const abortController = req.abortController;
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!streamId) {
            return res.status(400).json({ error: "Stream name is required." });
        }
        if (!wallet || !isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Valid wallet address is required." });
        }
        const [existingStream, requestingUser] = await Promise.all([
            executeQuery(() => db.stream.findFirst({
                where: {
                    name: streamId,
                    tenantId: tenant.id,
                },
                include: {
                    user: true,
                },
            }), { maxRetries: 1, timeout: 3000 }),
            executeQuery(() => db.user.findFirst({
                where: {
                    walletAddress: wallet,
                    tenantId: tenant.id,
                },
            }), { maxRetries: 1, timeout: 2000 })
        ]);
        // Check abort after queries
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
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
        const isCoHost = await executeQuery(() => db.participant.findFirst({
            where: {
                walletAddress: wallet,
                streamId: existingStream.id,
                userType: "co-host",
                tenantId: tenant.id,
                leftAt: null,
            },
        }), { maxRetries: 1, timeout: 2000 });
        if (!isHost && !isCoHost) {
            return res.status(403).json({
                error: "Only hosts and co-hosts can update streams.",
            });
        }
        const isLive = existingStream.isLive;
        const updateData = {};
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
                    if (!Object.values(StreamSessionType).includes(streamSessionType)) {
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
                    const effectiveEnabledTypes = tenantWithDetails.enabledStreamTypes || defaultEnabledTypes;
                    let isEnabled = false;
                    switch (streamSessionType) {
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
        }
        else if (scheduledFor !== undefined ||
            callType !== undefined ||
            streamSessionType !== undefined ||
            fundingType !== undefined) {
            return res.status(400).json({
                error: "Cannot update scheduledFor, callType, streamSessionType, or fundingType after stream has started",
                currentStatus: "Stream is live",
            });
        }
        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ error: "No valid fields provided for update." });
        }
        const updatedStream = await executeQuery(() => db.stream.update({
            where: {
                id: existingStream.id,
            },
            data: updateData,
        }), { maxRetries: 1, timeout: 3000 });
        // Invalidate cache
        streamCache.delete(`${tenant.id}:${streamId}`);
        streamCache.delete(`${tenant.id}:${streamId}:full`);
        success = true;
        if (!res.headersSent && !abortController?.signal?.aborted) {
            return res.status(200).json(updatedStream);
        }
    }
    catch (error) {
        console.error("Error updating stream:", error);
        if (res.headersSent)
            return;
        return res.status(500).json({
            error: "Internal server error",
        });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for ending stream - OPTIMIZED
 */
export const endStream = async (req, res) => {
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
            executeQuery(() => db.stream.findFirst({
                where: {
                    name: streamId,
                    tenantId: tenant.id,
                    isLive: true,
                },
                include: {
                    user: true,
                },
            }), { maxRetries: 2, timeout: 10000 }),
            executeQuery(() => db.user.findFirst({
                where: {
                    walletAddress: wallet,
                    tenantId: tenant.id,
                },
            }), { maxRetries: 2, timeout: 10000 })
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
                const egressService = new EgressClient(livekitHost, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
                await egressService.stopEgress(existingStream.recordId);
            }
            catch (recordingError) {
                console.error("Error stopping recording:", recordingError);
            }
        }
        const endedStream = await executeQuery(() => db.stream.update({
            where: { id: existingStream.id },
            data: {
                isLive: false,
                endedAt: new Date(),
                recording: false,
            },
        }), { maxRetries: 2, timeout: 10000 });
        // Invalidate cache
        streamCache.delete(`${tenant.id}:${streamId}`);
        streamCache.delete(`${tenant.id}:${streamId}:full`);
        success = true;
        return res.status(200).json({
            message: "Stream ended successfully",
            streamId: endedStream.id,
            streamName: endedStream.name,
            duration: endedStream.startedAt && endedStream.endedAt
                ? Math.floor((endedStream.endedAt.getTime() - endedStream.startedAt.getTime()) / 1000)
                : null,
        });
    }
    catch (error) {
        console.error("Error ending stream:", error);
        return res.status(500).json({
            error: "Internal server error",
        });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for streaming to YouTube - OPTIMIZED
 */
export const streamToYoutube = async (req, res) => {
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
            executeQuery(() => db.stream.findFirst({
                where: {
                    name: roomName,
                    tenantId: tenant.id,
                },
                include: {
                    user: true,
                },
            }), { maxRetries: 2, timeout: 10000 }),
            executeQuery(() => db.user.findFirst({
                where: {
                    walletAddress: wallet,
                    tenantId: tenant.id,
                },
            }), { maxRetries: 2, timeout: 10000 })
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
        let userType;
        if (user.id === stream.userId) {
            userType = "host";
        }
        else if (stream.streamSessionType === StreamSessionType.Meeting) {
            userType = "co-host";
        }
        else {
            userType = "guest";
        }
        if (userType !== "host") {
            return res.status(403).json({
                error: "Only the host can stream to YouTube.",
            });
        }
        const egressService = new EgressClient(livekitHost, process.env.LIVEKIT_API_KEY || "", process.env.LIVEKIT_API_SECRET || "");
        const output = {
            stream: new StreamOutput({
                protocol: StreamProtocol.RTMP,
                urls: [youtubeRtmpUrl],
            }),
        };
        const egressInfo = await egressService.startRoomCompositeEgress(roomName, output);
        if (!egressInfo) {
            return res.status(500).json({ error: "Failed to start YouTube stream. Please try again" });
        }
        await executeQuery(() => db.stream.update({
            where: { id: stream.id },
            data: {
                recording: true,
                recordId: egressInfo.egressId,
            },
        }), { maxRetries: 2, timeout: 10000 });
        // Invalidate cache
        streamCache.delete(`${tenant.id}:${roomName}`);
        success = true;
        return res.status(201).json({
            message: "YouTube streaming started",
            recordingId: egressInfo.egressId,
            streamId: stream.id,
        });
    }
    catch (error) {
        console.error("Error starting YouTube stream:", error);
        return res.status(500).json({
            error: "Internal server error",
            details: error instanceof Error ? error.message : String(error),
        });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for stopping YouTube stream - OPTIMIZED
 */
export const stopYoutubeStream = async (req, res) => {
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
            executeQuery(() => db.stream.findFirst({
                where: {
                    recordId,
                    tenantId: tenant.id,
                    recording: true,
                },
                include: {
                    user: true,
                },
            }), { maxRetries: 2, timeout: 10000 }),
            executeQuery(() => db.user.findFirst({
                where: {
                    walletAddress: wallet,
                    tenantId: tenant.id,
                },
            }), { maxRetries: 2, timeout: 10000 })
        ]);
        if (!stream) {
            return res.status(404).json({ error: "Active streaming session not found" });
        }
        if (!user) {
            return res.status(403).json({ error: "User not found" });
        }
        let userType;
        if (user.id === stream.userId) {
            userType = "host";
        }
        else if (stream.streamSessionType === StreamSessionType.Meeting) {
            userType = "co-host";
        }
        else {
            userType = "guest";
        }
        if (userType !== "host") {
            return res.status(403).json({
                error: "Only the host can stop YouTube streaming.",
            });
        }
        const egressService = new EgressClient(livekitHost, process.env.LIVEKIT_API_KEY || "", process.env.LIVEKIT_API_SECRET || "");
        await egressService.stopEgress(recordId);
        await executeQuery(() => db.stream.update({
            where: { id: stream.id },
            data: {
                recording: false,
            },
        }), { maxRetries: 2, timeout: 10000 });
        // Invalidate cache
        streamCache.delete(`${tenant.id}:${stream.name}`);
        success = true;
        return res.status(200).json({
            message: "YouTube streaming stopped successfully",
            streamId: stream.id,
            recordId: recordId,
        });
    }
    catch (error) {
        console.error("Error stopping YouTube stream:", error);
        return res.status(500).json({
            error: "Internal server error",
            details: error instanceof Error ? error.message : String(error),
        });
    }
    finally {
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
}, 60000);
