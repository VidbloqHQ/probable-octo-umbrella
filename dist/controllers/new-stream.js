import { AccessToken, EgressClient, StreamOutput, StreamProtocol, EncodingOptionsPreset } from "livekit-server-sdk";
import { StreamSessionType, CallType } from "@prisma/client";
import { db, executeQuery, trackQuery } from "../prisma.js";
import { isValidWalletAddress, roomService, livekitHost, } from "../utils/index.js";
// Cache for stream lookups
const streamCache = new Map();
const STREAM_CACHE_TTL = 30000; // 30 seconds
// Cache for tenant configuration
const tenantConfigCache = new Map();
const TENANT_CONFIG_CACHE_TTL = 300000; // 5 minutes
/**
 * OPTIMIZED: Generate guaranteed unique stream name
 * Format: "abc-def-xyz" (always 11 characters including dashes)
 */
function generateUniqueStreamName() {
    // 6-character random base
    const segments = 2;
    const segmentLength = 3;
    const charset = 'abcdefghijklmnopqrstuvwxyz0123456789';
    function generateSegment() {
        let segment = '';
        for (let i = 0; i < segmentLength; i++) {
            segment += charset[Math.floor(Math.random() * charset.length)];
        }
        return segment;
    }
    const base = Array(segments).fill(null).map(() => generateSegment()).join('-');
    // 3-character timestamp suffix for uniqueness
    const timestamp = Date.now() % 46656; // Ensures 3 chars in base36
    const suffix = timestamp.toString(36).padStart(3, '0');
    return `${base}-${suffix}`;
}
/**
 * OPTIMIZED: Create stream with async LiveKit room creation
 */
export const createStream = async (req, res) => {
    const { wallet, callType = "video", scheduledFor, title, streamSessionType, fundingType, isPublic = true, } = req.body;
    const tenant = req.tenant;
    let success = false;
    // const fullStart = Date.now();
    // console.log(`[TIMING] Request received`);
    // // Time each operation
    // console.log(`[TIMING] Starting tenant check`);
    try {
        const abortController = req.abortController;
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // console.log(`[TIMING] Tenant check: ${Date.now() - fullStart}ms`);
        // console.log(`[TIMING] Starting user upsert`);
        if (!wallet || !isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Valid wallet address required." });
        }
        // const userStart = Date.now();
        // Step 1: Upsert user first
        const user = await executeQuery(() => db.user.upsert({
            where: {
                walletAddress_tenantId: {
                    walletAddress: wallet,
                    tenantId: tenant.id,
                },
            },
            update: {},
            create: {
                walletAddress: wallet,
                tenantId: tenant.id,
                points: 0,
            },
        }), { maxRetries: 2, timeout: 3000 });
        // console.log(`[TIMING] User upsert completed: ${Date.now() - userStart}ms`);
        // console.log(`[TIMING] Starting stream creation`);
        // Step 2: Generate guaranteed unique stream name (no DB check needed)
        const streamName = generateUniqueStreamName();
        // const streamStart = Date.now();
        // Step 3: Create stream
        const stream = await executeQuery(() => db.stream.create({
            data: {
                name: streamName,
                title,
                callType: callType === "audio" ? CallType.Audio : CallType.Video,
                creatorWallet: wallet,
                streamSessionType: streamSessionType || tenant.defaultStreamType,
                fundingType: fundingType || tenant.defaultFundingType,
                isPublic,
                scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
                tenantId: tenant.id,
                userId: user.id,
                hasHost: false,
                recording: false,
                isLive: false,
                createdAt: new Date(),
            },
        }), { maxRetries: 2, timeout: 5000 });
        // console.log(
        //   `[TIMING] Stream creation completed: ${Date.now() - streamStart}ms`
        // );
        // console.log(`[TIMING] Total request time: ${Date.now() - fullStart}ms`);
        // Step 4: Create LiveKit room asynchronously (fire and forget)
        setImmediate(() => {
            roomService
                .createRoom({
                name: streamName,
                emptyTimeout: 300,
                maxParticipants: 100,
            })
                .catch((err) => {
                console.error(`LiveKit room creation failed for ${streamName}:`, err);
                // Could implement retry logic here if needed
            });
        });
        success = true;
        if (!res.headersSent && !abortController?.signal?.aborted) {
            return res.status(201).json(stream);
        }
    }
    catch (error) {
        console.error("Error creating stream:", error);
        if (res.headersSent)
            return;
        if (error.message === "Query timeout" || error.code === "TIMEOUT") {
            return res.status(504).json({
                error: "Database query timeout",
                message: "The operation took too long. Please try again.",
            });
        }
        return res.status(500).json({ error: "Internal server error" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * OPTIMIZED: Create stream token with parallel operations and better caching
 */
export const createStreamToken = async (req, res) => {
    const { roomName, userName, wallet, avatarUrl } = req.body;
    const tenant = req.tenant;
    let success = false;
    // console.log("[NEW-STREAM] createStreamToken called at", Date.now());
    try {
        const abortController = req.abortController;
        if (res.headersSent || abortController?.signal?.aborted) {
            return;
        }
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!roomName || !userName || !wallet || !isValidWalletAddress(wallet)) {
            return res.status(400).json({
                error: "Missing or invalid required fields",
            });
        }
        // OPTIMIZATION: Parallel operations instead of sequential
        const [existingStream, user] = await Promise.all([
            // Fetch stream with minimal data
            executeQuery(() => db.stream.findFirst({
                where: {
                    name: roomName,
                    tenantId: tenant.id,
                },
                select: {
                    id: true,
                    name: true,
                    userId: true,
                    hasHost: true,
                    isPublic: true,
                    isLive: true,
                    streamSessionType: true,
                    startedAt: true,
                    creatorWallet: true,
                },
            }), { maxRetries: 1, timeout: 1500 }),
            // Upsert user in parallel
            executeQuery(() => db.user.upsert({
                where: {
                    walletAddress_tenantId: {
                        walletAddress: wallet,
                        tenantId: tenant.id,
                    },
                },
                update: {},
                create: {
                    walletAddress: wallet,
                    tenantId: tenant.id,
                    points: 0,
                },
            }), { maxRetries: 1, timeout: 1500 }),
        ]);
        if (!existingStream) {
            return res.status(404).json({ error: "Stream not found" });
        }
        // Determine userType
        let userType;
        if (user.id === existingStream.userId ||
            existingStream.creatorWallet === wallet) {
            userType = "host";
        }
        else if (existingStream.streamSessionType === StreamSessionType.Meeting) {
            userType = "co-host";
        }
        else {
            userType = "guest";
        }
        // Check access permissions
        if (!existingStream.isPublic && userType === "guest") {
            return res
                .status(403)
                .json({ error: "This stream requires permission to join" });
        }
        if (userType === "guest" && !existingStream.hasHost) {
            return res.status(403).json({ error: "Waiting for host to join" });
        }
        // OPTIMIZATION: Start both operations in parallel
        const participantPromise = executeQuery(() => db.participant.upsert({
            where: {
                walletAddress_streamId_tenantId: {
                    walletAddress: wallet,
                    streamId: existingStream.id,
                    tenantId: tenant.id,
                },
            },
            update: {
                userName,
                userType,
                leftAt: null,
                ...(avatarUrl && { avatarUrl }),
            },
            create: {
                userName,
                walletAddress: wallet,
                userType,
                streamId: existingStream.id,
                tenantId: tenant.id,
                totalPoints: 0,
                ...(avatarUrl && { avatarUrl }),
            },
        }), { maxRetries: 1, timeout: 2000 });
        // FIXED: Use atomic update for host status
        let streamUpdatePromise = Promise.resolve();
        if (userType === "host" && !existingStream.hasHost) {
            streamUpdatePromise = executeQuery(() => db.stream.updateMany({
                where: {
                    id: existingStream.id,
                    hasHost: false,
                },
                data: {
                    hasHost: true,
                    isLive: true,
                    startedAt: existingStream.startedAt || new Date(),
                },
            }), { maxRetries: 1, timeout: 2000 })
                .then(() => {
                // Convert BatchPayload to void by not returning anything
                return;
            })
                .catch((err) => {
                console.error(`Failed to update stream status: ${err.message}`);
                // Non-critical - continue anyway
            });
        }
        // Wait for participant creation (required), stream update is optional
        const [participant] = await Promise.all([
            participantPromise,
            streamUpdatePromise,
        ]);
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
        // Invalidate stream cache if host joined
        if (userType === "host" && !existingStream.hasHost) {
            const cacheKey = `${tenant.id}:${roomName}`;
            streamCache.delete(cacheKey);
        }
        success = true;
        if (!res.headersSent && !abortController?.signal?.aborted) {
            return res.status(200).json({ token, userType });
        }
    }
    catch (error) {
        console.error("Error creating token:", error);
        if (res.headersSent)
            return;
        if (error.message === "Query timeout" || error.code === "TIMEOUT") {
            return res.status(504).json({
                error: "Database query timeout",
                message: "The operation took too long. Please try again.",
            });
        }
        if (error.message?.includes("permission") ||
            error.message?.includes("Waiting for host")) {
            return res.status(403).json({ error: error.message });
        }
        return res.status(500).json({ error: "Internal server error" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * OPTIMIZED: Get stream with selective data loading
 */
export const getStream = async (req, res) => {
    const { streamId } = req.params;
    const tenant = req.tenant;
    let success = false;
    // console.log("[NEW-STREAM] getStream called at", Date.now());
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
        // OPTIMIZED: Fetch stream with limited nested data
        const stream = await executeQuery(() => db.stream.findFirst({
            where: {
                name: streamId,
                tenantId: tenant.id,
            },
            include: {
                // Only get counts
                _count: {
                    select: {
                        agenda: true,
                        participants: true,
                    },
                },
                // Get limited agenda data
                agenda: {
                    select: {
                        id: true,
                        timeStamp: true,
                        action: true,
                        title: true,
                        isCompleted: true,
                    },
                    orderBy: {
                        timeStamp: "asc",
                    },
                    take: 20, // Only first 20 agendas
                },
                // Get active participants only
                participants: {
                    where: {
                        leftAt: null,
                    },
                    select: {
                        id: true,
                        userName: true,
                        walletAddress: true,
                        userType: true,
                        avatarUrl: true,
                        joinedAt: true,
                        totalPoints: true,
                    },
                    orderBy: {
                        joinedAt: "desc",
                    },
                    take: 30, // Only 30 active participants
                },
            },
        }), { maxRetries: 1, timeout: 2000 });
        if (!stream) {
            return res.status(404).json({ error: "Stream not found." });
        }
        const streamWithCounts = {
            ...stream,
            totalAgendas: stream._count?.agenda || 0,
            totalParticipants: stream._count?.participants || 0,
            activeParticipants: stream.participants?.length || 0,
            _count: undefined, // Remove _count from response
        };
        // Cache the result
        streamCache.set(cacheKey, {
            data: streamWithCounts,
            timestamp: Date.now(),
        });
        success = true;
        return res.status(200).json(streamWithCounts);
    }
    catch (error) {
        console.error("Error fetching stream:", error);
        if (res.headersSent)
            return;
        if (error.message === "Query timeout" || error.code === "TIMEOUT") {
            return res.status(504).json({
                error: "Database query timeout",
                message: "The request took too long. Please try again.",
            });
        }
        return res.status(500).json({ error: "Internal server error" });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for streaming to YouTube - ENHANCED VERSION
 */
export const streamToYoutube = async (req, res) => {
    const { roomName, wallet, youtubeRtmpUrl, layout = 'speaker', // 'grid', 'speaker', or 'single-speaker'
    quality = {}, } = req.body;
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
        // if (stream.recording) {
        //   return res.status(400).json({
        //     error: "Stream is already being recorded or streamed",
        //     recordId: stream.recordId,
        //   });
        // }
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
        // Quality settings with defaults
        const videoSettings = {
            width: quality.width || 1920,
            height: quality.height || 1080,
            framerate: quality.framerate || 30,
            videoBitrate: quality.videoBitrate || 4500,
        };
        const audioBitrate = quality.audioBitrate || 128;
        // Determine layout preset
        const layoutPreset = layout === 'speaker'
            ? 'speaker-dark'
            : layout === 'single-speaker'
                ? 'single-speaker'
                : 'grid-dark';
        // Configure output
        const output = new StreamOutput({
            protocol: StreamProtocol.RTMP,
            urls: [youtubeRtmpUrl],
        });
        // Select encoding preset based on quality settings
        // Note: Presets include proper audio bitrate (128kbps) by default
        let encodingPreset;
        if (videoSettings.width >= 1920 && videoSettings.height >= 1080) {
            // 1080p presets (best quality, includes 128kbps audio)
            encodingPreset = videoSettings.framerate >= 60
                ? EncodingOptionsPreset.H264_1080P_60
                : EncodingOptionsPreset.H264_1080P_30;
        }
        else if (videoSettings.width >= 1280 && videoSettings.height >= 720) {
            // 720p presets
            encodingPreset = videoSettings.framerate >= 60
                ? EncodingOptionsPreset.H264_720P_60
                : EncodingOptionsPreset.H264_720P_30;
        }
        else {
            // Default to 1080p30 for best quality
            encodingPreset = EncodingOptionsPreset.H264_1080P_30;
        }
        // Start egress
        const egressInfo = await egressService.startRoomCompositeEgress(roomName, output, {
            layout: layoutPreset,
            encodingOptions: encodingPreset,
            audioOnly: false,
            videoOnly: false,
        });
        if (!egressInfo) {
            return res.status(500).json({
                error: "Failed to start YouTube stream. Please try again"
            });
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
            config: {
                layout,
                quality: videoSettings,
            },
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
// Stop controller remains the same
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
/**
 * Controller for streaming to Facebook Live
 */
export const streamToFacebook = async (req, res) => {
    const { roomName, wallet, facebookRtmpUrl, layout = "speaker", // 'grid', 'speaker', or 'single-speaker'
    quality = {}, } = req.body;
    const tenant = req.tenant;
    let success = false;
    try {
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!roomName || !wallet || typeof wallet !== "string" || !facebookRtmpUrl) {
            return res.status(400).json({
                error: "Missing required fields: room name, wallet, or Facebook RTMP URL",
            });
        }
        if (!isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Invalid wallet address format." });
        }
        if (!facebookRtmpUrl.startsWith("rtmp://") &&
            !facebookRtmpUrl.startsWith("rtmps://")) {
            return res.status(400).json({
                error: "Invalid Facebook RTMP URL format. Should start with rtmp:// or rtmps://",
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
            }), { maxRetries: 2, timeout: 10000 }),
        ]);
        if (!stream) {
            return res.status(404).json({ error: "Stream not found." });
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
                error: "Only the host can stream to Facebook.",
            });
        }
        // Optional guard if you want to prevent starting another stream while one is active
        // if (stream.recording) {
        //   return res.status(400).json({
        //     error: "Stream is already being recorded or streamed",
        //     recordId: stream.recordId,
        //   });
        // }
        const egressService = new EgressClient(livekitHost, process.env.LIVEKIT_API_KEY || "", process.env.LIVEKIT_API_SECRET || "");
        const videoSettings = {
            width: quality.width || 1920,
            height: quality.height || 1080,
            framerate: quality.framerate || 30,
            videoBitrate: quality.videoBitrate || 4500,
        };
        const audioBitrate = quality.audioBitrate || 128;
        const layoutPreset = layout === "speaker"
            ? "speaker-dark"
            : layout === "single-speaker"
                ? "single-speaker"
                : "grid-dark";
        const output = new StreamOutput({
            protocol: StreamProtocol.RTMP,
            urls: [facebookRtmpUrl],
        });
        let encodingPreset;
        if (videoSettings.width >= 1920 && videoSettings.height >= 1080) {
            encodingPreset =
                videoSettings.framerate >= 60
                    ? EncodingOptionsPreset.H264_1080P_60
                    : EncodingOptionsPreset.H264_1080P_30;
        }
        else if (videoSettings.width >= 1280 && videoSettings.height >= 720) {
            encodingPreset =
                videoSettings.framerate >= 60
                    ? EncodingOptionsPreset.H264_720P_60
                    : EncodingOptionsPreset.H264_720P_30;
        }
        else {
            encodingPreset = EncodingOptionsPreset.H264_1080P_30;
        }
        const egressInfo = await egressService.startRoomCompositeEgress(roomName, output, {
            layout: layoutPreset,
            encodingOptions: encodingPreset,
            audioOnly: false,
            videoOnly: false,
        });
        if (!egressInfo) {
            return res.status(500).json({
                error: "Failed to start Facebook stream. Please try again.",
            });
        }
        await executeQuery(() => db.stream.update({
            where: { id: stream.id },
            data: {
                recording: true,
                recordId: egressInfo.egressId,
            },
        }), { maxRetries: 2, timeout: 10000 });
        streamCache.delete(`${tenant.id}:${roomName}`);
        success = true;
        return res.status(201).json({
            message: "Facebook streaming started",
            recordingId: egressInfo.egressId,
            streamId: stream.id,
            config: {
                layout,
                quality: {
                    ...videoSettings,
                    audioBitrate,
                },
            },
        });
    }
    catch (error) {
        console.error("Error starting Facebook stream:", error);
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
 * Controller for stopping Facebook Live stream
 */
export const stopFacebookStream = async (req, res) => {
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
            }), { maxRetries: 2, timeout: 10000 }),
        ]);
        if (!stream) {
            return res.status(404).json({ error: "Active Facebook streaming session not found" });
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
                error: "Only the host can stop Facebook streaming.",
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
        streamCache.delete(`${tenant.id}:${stream.name}`);
        success = true;
        return res.status(200).json({
            message: "Facebook streaming stopped successfully",
            streamId: stream.id,
            recordId,
        });
    }
    catch (error) {
        console.error("Error stopping Facebook stream:", error);
        return res.status(500).json({
            error: "Internal server error",
            details: error instanceof Error ? error.message : String(error),
        });
    }
    finally {
        trackQuery(success);
    }
};
