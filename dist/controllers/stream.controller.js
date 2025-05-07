import { AccessToken, EgressClient, EncodedFileOutput, StreamOutput, StreamProtocol, } from "livekit-server-sdk";
import { StreamSessionType, CallType, StreamFundingType } from "@prisma/client";
import { db } from "../prisma.js";
import { generateMeetingLink, isValidWalletAddress, roomService, livekitHost, getAvatarForUser } from "../utils/index.js";
/**
 * Helper function to generate a unique stream name
 * @param tenantId - The ID of the tenant for which to generate a unique stream name
 * @returns A unique stream name
 */
async function generateUniqueStreamName(tenantId) {
    if (!tenantId) {
        throw new Error("Tenant ID is required to generate a unique stream name");
    }
    let isUnique = false;
    let streamName = "";
    while (!isUnique) {
        streamName = generateMeetingLink();
        // Check if the stream name is unique within this tenant
        const existingStream = await db.stream.findFirst({
            where: {
                name: streamName,
                tenantId: tenantId,
            },
        });
        if (!existingStream) {
            isUnique = true;
        }
    }
    return streamName;
}
/**
 * Helper function to get enabled stream types for a tenant
 * @param tenant - The tenant object
 * @returns An array of enabled stream types
 */
function getEnabledStreamTypes(tenant, defaultTypes = null) {
    const enabledTypes = [];
    // Either use the tenant's enabledStreamTypes or the defaults
    const effectiveTypes = tenant.enabledStreamTypes || defaultTypes || {
        enableStream: true,
        enableMeeting: true,
        enablePodcast: false
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
 * Controller for creating a stream
 */
export const createStream = async (req, res) => {
    const { wallet, callType = "video", scheduledFor, title, streamSessionType, // Optional override to tenant default
    fundingType, // Optional override to tenant default
    isPublic = true, } = req.body;
    const tenant = req.tenant;
    try {
        // Tenant check
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!wallet || typeof wallet !== "string") {
            return res.status(400).json({ error: "Wallet address is required." });
        }
        if (!isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Invalid wallet address format." });
        }
        // Get tenant with more details
        const tenantWithDetails = await db.tenant.findUnique({
            where: { id: tenant.id },
            include: { enabledStreamTypes: true }
        });
        if (!tenantWithDetails) {
            return res.status(404).json({ error: "Tenant configuration not found." });
        }
        // Define default enabled types based on schema defaults
        // These will be used when the tenant doesn't have enabledStreamTypes set
        const defaultEnabledTypes = {
            enableStream: true, // Default from schema
            enableMeeting: true, // Default from schema
            enablePodcast: false, // Default from schema
        };
        // Use either the stored enabledStreamTypes or the defaults
        const effectiveEnabledTypes = tenantWithDetails.enabledStreamTypes || defaultEnabledTypes;
        // Determine stream session type to use
        let resolvedStreamSessionType;
        // CASE 1: User specified a stream type
        if (streamSessionType) {
            // Type validation - ensure streamSessionType is a valid enum value
            if (!Object.values(StreamSessionType).includes(streamSessionType)) {
                return res.status(400).json({
                    error: "Invalid streamSessionType value",
                    validTypes: Object.values(StreamSessionType)
                });
            }
            // Check if the requested type is enabled using effective types
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
                return res.status(403).json({
                    error: `${streamSessionType} is not enabled for this tenant`,
                    allowedTypes: getEnabledStreamTypes(tenantWithDetails, defaultEnabledTypes)
                });
            }
            // If we passed the validation, use the requested type
            resolvedStreamSessionType = streamSessionType;
        }
        // CASE 2: Use tenant default
        else {
            // Start with the tenant default
            resolvedStreamSessionType = tenantWithDetails.defaultStreamType;
            // Check if default type is enabled using effective types
            let isDefaultEnabled = false;
            switch (resolvedStreamSessionType) {
                case StreamSessionType.Livestream:
                    isDefaultEnabled = effectiveEnabledTypes.enableStream;
                    break;
                case StreamSessionType.Meeting:
                    isDefaultEnabled = effectiveEnabledTypes.enableMeeting;
                    break;
                case StreamSessionType.Podcast:
                    isDefaultEnabled = effectiveEnabledTypes.enablePodcast;
                    break;
            }
            // If the default type is disabled, try to find an enabled type
            if (!isDefaultEnabled) {
                if (effectiveEnabledTypes.enableStream) {
                    resolvedStreamSessionType = StreamSessionType.Livestream;
                }
                else if (effectiveEnabledTypes.enableMeeting) {
                    resolvedStreamSessionType = StreamSessionType.Meeting;
                }
                else if (effectiveEnabledTypes.enablePodcast) {
                    resolvedStreamSessionType = StreamSessionType.Podcast;
                }
                else {
                    // No types are enabled (shouldn't happen with defaults, but just in case)
                    return res.status(403).json({
                        error: "No stream types are enabled for this tenant",
                        defaultType: tenantWithDetails.defaultStreamType,
                        enabledTypes: []
                    });
                }
            }
        }
        // Final validation check before proceeding
        let isFinalTypeEnabled = false;
        switch (resolvedStreamSessionType) {
            case StreamSessionType.Livestream:
                isFinalTypeEnabled = effectiveEnabledTypes.enableStream;
                break;
            case StreamSessionType.Meeting:
                isFinalTypeEnabled = effectiveEnabledTypes.enableMeeting;
                break;
            case StreamSessionType.Podcast:
                isFinalTypeEnabled = effectiveEnabledTypes.enablePodcast;
                break;
        }
        if (!isFinalTypeEnabled) {
            return res.status(403).json({
                error: `${resolvedStreamSessionType} is not enabled for this tenant`,
                allowedTypes: getEnabledStreamTypes(tenantWithDetails, defaultEnabledTypes)
            });
        }
        // Determine funding type to use (no validation needed here)
        let resolvedFundingType = fundingType || tenantWithDetails.defaultFundingType;
        // Validate call type
        let resolvedCallType;
        switch ((callType || '').toLowerCase()) {
            case "video":
                resolvedCallType = CallType.Video;
                break;
            case "audio":
                resolvedCallType = CallType.Audio;
                break;
            default:
                return res.status(400).json({
                    error: "Invalid callType. Must be 'video' or 'audio'",
                    allowedValues: Object.values(CallType)
                });
        }
        // Date validation (if provided)
        if (scheduledFor && new Date(scheduledFor) < new Date()) {
            return res
                .status(400)
                .json({ error: "Cannot schedule a stream in the past." });
        }
        // Find or create user
        let user = await db.user.findFirst({
            where: {
                walletAddress: wallet,
                tenantId: tenant.id,
            },
        });
        if (!user) {
            user = await db.user.create({
                data: {
                    walletAddress: wallet,
                    tenantId: tenant.id,
                },
            });
        }
        // Generate unique stream name
        const streamName = await generateUniqueStreamName(tenant.id);
        // Create LiveKit room
        const { name } = await roomService.createRoom({
            name: streamName,
            emptyTimeout: 300, // Default: 5 min timeout
            maxParticipants: 100, // Default capacity
        });
        // Create stream with tenant's defaults
        const stream = await db.stream.create({
            data: {
                name,
                title,
                callType: resolvedCallType,
                creatorWallet: wallet,
                streamSessionType: resolvedStreamSessionType,
                fundingType: resolvedFundingType,
                isPublic: isPublic,
                scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
                tenantId: tenant.id,
                userId: user.id,
            },
        });
        res.status(201).json(stream);
    }
    catch (error) {
        console.error("Error creating stream:", error);
        res.status(500).json({ error: "Internal server error" });
    }
    finally {
        await db.$disconnect();
    }
};
/**
 * Controller for creating access token for stream
 */
export const createStreamToken = async (req, res) => {
    const { roomName, userName, wallet } = req.body;
    const tenant = req.tenant;
    try {
        // Tenant check
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // Validate inputs
        if (!roomName || !userName || !wallet || typeof wallet !== "string") {
            return res.status(400).json({
                error: "Missing required fields: room name, wallet, and user name",
            });
        }
        if (!isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Invalid wallet address format." });
        }
        // Find the stream with tenant check
        const existingStream = await db.stream.findFirst({
            where: {
                name: roomName,
                tenantId: tenant.id,
            },
            include: { user: true },
        });
        if (!existingStream) {
            return res.status(404).json({ error: "Stream not found" });
        }
        let user = await db.user.findFirst({
            where: {
                walletAddress: wallet,
                tenantId: tenant.id,
            },
        });
        if (!user) {
            user = await db.user.create({
                data: {
                    walletAddress: wallet,
                    tenantId: tenant.id,
                },
            });
        }
        // Determine userType
        let userType;
        if (user.id === existingStream.userId) {
            userType = "host";
        }
        else if (existingStream.streamSessionType === StreamSessionType.Meeting) {
            userType = "co-host";
        }
        // else if (existingStream.streamSessionType === StreamSessionType.Livestream) {
        //   userType = "co-host";
        // } 
        else {
            userType = "guest";
        }
        // Check access permissions if stream is not public
        if (!existingStream.isPublic && userType === "guest") {
            // Here you would check if the user has explicit permission to join
            // This would be implemented based on your permission model
            const hasPermission = false; // Replace with actual permission check
            if (!hasPermission) {
                return res.status(403).json({
                    error: "This stream requires permission to join",
                });
            }
        }
        // Guest join validation
        if (userType === "guest" && !existingStream.hasHost) {
            return res.status(403).json({
                error: "Cannot join: Waiting for host to join the room",
            });
        }
        // Create/update participant with tenant
        const existingParticipant = await db.participant.findFirst({
            where: {
                walletAddress: wallet,
                streamId: existingStream.id,
                tenantId: tenant.id,
            },
        });
        let participant;
        if (existingParticipant) {
            if (existingParticipant.leftAt) {
                participant = await db.participant.update({
                    where: { id: existingParticipant.id },
                    data: {
                        leftAt: null,
                        userName,
                        userType,
                    },
                });
            }
            else {
                participant = existingParticipant;
            }
        }
        else {
            participant = await db.participant.create({
                data: {
                    userName,
                    walletAddress: wallet,
                    userType,
                    streamId: existingStream.id,
                    tenantId: tenant.id,
                },
            });
        }
        // might store avatarUrls in the database
        const avatarUrl = getAvatarForUser(participant.id);
        // Update stream status if host joins
        if (userType === "host") {
            await db.stream.update({
                where: { id: existingStream.id },
                data: {
                    hasHost: true,
                    isLive: true,
                    startedAt: existingStream.startedAt || new Date(), // Set startedAt if not already set
                },
            });
        }
        // Generate token
        const accessToken = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
            identity: userName,
            ttl: "60m",
            metadata: JSON.stringify({
                userName,
                participantId: participant.id,
                userType,
                avatarUrl,
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
        res.status(200).json({ token, userType });
    }
    catch (error) {
        console.error("Error creating token:", error);
        res.status(500).json({ error: "Internal server error" });
    }
    finally {
        await db.$disconnect();
    }
};
/**
 * Controller for getting stream details
 */
export const getStream = async (req, res) => {
    const { streamId } = req.params;
    const tenant = req.tenant;
    try {
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!streamId) {
            return res.status(400).json({ error: "Missing stream ID." });
        }
        const stream = await db.stream.findFirst({
            where: {
                name: streamId,
                tenantId: tenant.id,
            },
            include: {
                agenda: {
                    include: {
                        pollContent: true,
                        quizContent: {
                            include: { questions: true },
                        },
                        assetTransferContent: true,
                        qaContent: true,
                        customContent: true,
                    },
                },
                participants: true,
            },
        });
        if (!stream) {
            return res.status(404).json({ error: "Stream not found." });
        }
        res.status(200).json(stream);
    }
    catch (error) {
        console.error("Error fetching stream:", error);
        res.status(500).json({ error: "Internal server error" });
    }
    finally {
        await db.$disconnect();
    }
};
/**
 * Controller for starting a stream recording
 */
export const recordStream = async (req, res) => {
    const { roomName, wallet } = req.body;
    const tenant = req.tenant;
    try {
        // 1. Tenant verification
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // 2. Input validation
        if (!roomName || !wallet || typeof wallet !== "string") {
            return res.status(400).json({
                error: "Missing required fields: room name and wallet",
            });
        }
        if (!isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Invalid wallet address format." });
        }
        // 3. Verify stream belongs to tenant and include user relationship
        const stream = await db.stream.findFirst({
            where: {
                name: roomName,
                tenantId: tenant.id,
            },
            include: {
                user: true,
            },
        });
        if (!stream) {
            return res
                .status(404)
                .json({ error: "Stream not found." });
        }
        // 4. Check if stream is already being recorded
        if (stream.recording) {
            return res.status(400).json({
                error: "Stream is already being recorded",
                recordId: stream.recordId,
            });
        }
        // 5. Get user and determine user type
        const user = await db.user.findFirst({
            where: {
                walletAddress: wallet,
                tenantId: tenant.id,
            },
        });
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
        // 6. Verify user has recording privileges
        if (userType !== "host" && userType !== "co-host") {
            return res.status(403).json({
                error: "Only hosts and co-hosts can record streams.",
            });
        }
        // 7. Start recording
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
        console.log({ egressInfo });
        await db.stream.update({
            where: { id: stream.id },
            data: {
                recording: true,
                recordId: egressInfo.egressId, // Store the recording ID
            },
        });
        res.status(201).json({
            message: "Recording started",
            recordingId: egressInfo.egressId,
            streamId: stream.id,
        });
    }
    catch (error) {
        console.error("Error starting recording:", error);
        res.status(500).json({
            error: "Internal server error",
            details: error instanceof Error ? error.message : String(error),
        });
    }
    finally {
        await db.$disconnect();
    }
};
/**
 * Controller for stopping a stream recording
 */
export const stopStreamRecord = async (req, res) => {
    const { recordId, wallet } = req.body;
    const tenant = req.tenant;
    try {
        // 1. Tenant verification
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // 2. Input validation
        if (!recordId || !wallet || typeof wallet !== "string") {
            return res.status(400).json({
                error: "Missing required fields: recordId and wallet",
            });
        }
        if (!isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Invalid wallet address format." });
        }
        // 3. Find the stream with this recording
        const stream = await db.stream.findFirst({
            where: {
                recordId,
                tenantId: tenant.id,
                recording: true,
            },
            include: {
                user: true,
            },
        });
        if (!stream) {
            return res.status(404).json({ error: "Active recording not found" });
        }
        // 4. Verify user permissions
        const user = await db.user.findFirst({
            where: {
                walletAddress: wallet,
                tenantId: tenant.id,
            },
        });
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
        // 5. Verify user has recording privileges
        if (userType !== "host" && userType !== "co-host") {
            return res.status(403).json({
                error: "Only hosts and co-hosts can stop recordings.",
            });
        }
        // 6. Stop the recording
        const egressService = new EgressClient(livekitHost, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
        await egressService.stopEgress(recordId);
        // 7. Update stream record
        await db.stream.update({
            where: { id: stream.id },
            data: {
                recording: false,
                // recordLink will be set when the recording is processed and available
            },
        });
        res.status(200).json({
            message: "Recording stopped successfully",
            streamId: stream.id,
            recordId: recordId,
        });
    }
    catch (error) {
        console.error("Error stopping recording:", error);
        res.status(500).json({
            error: "Internal server error",
            details: error instanceof Error ? error.message : String(error),
        });
    }
    finally {
        await db.$disconnect();
    }
};
/**
 * Controller for updating a stream
 */
export const updateStream = async (req, res) => {
    const { streamId } = req.params;
    const { scheduledFor, title, callType, streamSessionType, fundingType, isPublic, wallet } = req.body;
    const tenant = req.tenant;
    try {
        // 1. Tenant verification
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
        // 2. Find the stream by name
        const existingStream = await db.stream.findFirst({
            where: {
                name: streamId,
                tenantId: tenant.id,
            },
            include: {
                user: true
            }
        });
        if (!existingStream) {
            return res.status(404).json({
                error: "Stream not found or access denied.",
                details: `Stream with name "${streamId}" not found`
            });
        }
        // 3. Verify requesting user exists
        const requestingUser = await db.user.findFirst({
            where: {
                walletAddress: wallet,
                tenantId: tenant.id,
            },
        });
        if (!requestingUser) {
            return res.status(403).json({ error: "User not authorized." });
        }
        // 4. Check permissions (host or co-host)
        const isHost = requestingUser.id === existingStream.userId;
        const isCoHost = await db.participant.findFirst({
            where: {
                walletAddress: wallet,
                streamId: existingStream.id,
                userType: "co-host",
                tenantId: tenant.id,
                leftAt: null
            }
        });
        if (!isHost && !isCoHost) {
            return res.status(403).json({
                error: "Only hosts and co-hosts can update streams."
            });
        }
        // 5. Check if the stream is live
        const isLive = existingStream.isLive;
        // 6. Prepare update data with strict permission rules
        const updateData = {};
        // Title can always be updated by both roles
        if (title !== undefined) {
            if (typeof title !== "string" || title.trim().length === 0) {
                return res.status(400).json({ error: "Invalid title format." });
            }
            updateData.title = title.trim();
        }
        // Access permissions can be updated
        if (isPublic !== undefined) {
            updateData.isPublic = !!isPublic;
        }
        // Fields that can only be updated if stream is not live
        if (!isLive) {
            // Host can update most fields
            if (isHost) {
                // Stream session type
                if (streamSessionType !== undefined) {
                    // Type validation - ensure streamSessionType is a valid enum value
                    if (!Object.values(StreamSessionType).includes(streamSessionType)) {
                        return res.status(400).json({
                            error: "Invalid streamSessionType value",
                            validTypes: Object.values(StreamSessionType)
                        });
                    }
                    // Get tenant with stream type configuration
                    const tenantWithDetails = await db.tenant.findUnique({
                        where: { id: tenant.id },
                        include: { enabledStreamTypes: true }
                    });
                    if (!tenantWithDetails) {
                        return res.status(400).json({ error: "Tenant configuration not found." });
                    }
                    // Define default enabled types based on schema defaults
                    const defaultEnabledTypes = {
                        enableStream: true, // Default from schema
                        enableMeeting: true, // Default from schema
                        enablePodcast: false, // Default from schema
                    };
                    // Use either the stored enabledStreamTypes or the defaults
                    const effectiveEnabledTypes = tenantWithDetails.enabledStreamTypes || defaultEnabledTypes;
                    // Check if the requested type is enabled
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
                        // Generate the list of allowed types
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
                            allowedTypes: allowedTypes
                        });
                    }
                    // If validation passes, update the stream session type
                    updateData.streamSessionType = streamSessionType;
                }
                // Funding type
                if (fundingType !== undefined) {
                    if (!Object.values(StreamFundingType).includes(fundingType)) {
                        return res.status(400).json({
                            error: "Invalid fundingType value.",
                            validTypes: Object.values(StreamFundingType)
                        });
                    }
                    updateData.fundingType = fundingType;
                }
                // Schedule updates
                if (scheduledFor !== undefined) {
                    updateData.scheduledFor = scheduledFor ? new Date(scheduledFor) : null;
                }
            }
            // Both roles can update callType if stream hasn't started
            if (callType !== undefined) {
                if (!Object.values(CallType).includes(callType)) {
                    return res.status(400).json({
                        error: "Invalid callType value.",
                        validTypes: Object.values(CallType)
                    });
                }
                updateData.callType = callType;
            }
        }
        else if (scheduledFor !== undefined || callType !== undefined || streamSessionType !== undefined || fundingType !== undefined) {
            return res.status(400).json({
                error: "Cannot update scheduledFor, callType, streamSessionType, or fundingType after stream has started",
                currentStatus: "Stream is live"
            });
        }
        // 7. Validate we have something to update
        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ error: "No valid fields provided for update." });
        }
        // 8. Perform the update using the stream's ID
        const updatedStream = await db.stream.update({
            where: {
                id: existingStream.id,
            },
            data: updateData,
        });
        return res.status(200).json(updatedStream);
    }
    catch (error) {
        console.error("Error updating stream:", error);
        return res.status(500).json({
            error: "Internal server error",
        });
    }
    finally {
        await db.$disconnect();
    }
};
/**
 * Controller for ending a stream
 */
export const endStream = async (req, res) => {
    const { streamId } = req.params;
    const { wallet } = req.body;
    const tenant = req.tenant;
    try {
        // 1. Tenant verification
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
        // 2. Find the stream by name
        const existingStream = await db.stream.findFirst({
            where: {
                name: streamId,
                tenantId: tenant.id,
                isLive: true
            },
            include: {
                user: true
            }
        });
        if (!existingStream) {
            return res.status(404).json({
                error: "Active stream not found",
                details: `Stream with name "${streamId}" not found or is not currently live`
            });
        }
        // 3. Verify requesting user exists
        const requestingUser = await db.user.findFirst({
            where: {
                walletAddress: wallet,
                tenantId: tenant.id,
            },
        });
        if (!requestingUser) {
            return res.status(403).json({ error: "User not authorized." });
        }
        // 4. Check permissions (only host can end a stream)
        const isHost = requestingUser.id === existingStream.userId;
        if (!isHost) {
            return res.status(403).json({
                error: "Only the host can end this stream"
            });
        }
        // 5. Stop any active recordings
        if (existingStream.recording && existingStream.recordId) {
            try {
                const egressService = new EgressClient(livekitHost, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
                await egressService.stopEgress(existingStream.recordId);
            }
            catch (recordingError) {
                console.error("Error stopping recording:", recordingError);
                // Continue with ending the stream even if stopping recording fails
            }
        }
        // 6. End the stream
        const endedStream = await db.stream.update({
            where: { id: existingStream.id },
            data: {
                isLive: false,
                endedAt: new Date(),
                recording: false
            }
        });
        return res.status(200).json({
            message: "Stream ended successfully",
            streamId: endedStream.id,
            streamName: endedStream.name,
            duration: endedStream.startedAt && endedStream.endedAt ?
                Math.floor((endedStream.endedAt.getTime() - endedStream.startedAt.getTime()) / 1000) :
                null
        });
    }
    catch (error) {
        console.error("Error ending stream:", error);
        return res.status(500).json({
            error: "Internal server error",
        });
    }
    finally {
        await db.$disconnect();
    }
};
/**
 * Controller for starting a stream to YouTube
 */
export const streamToYoutube = async (req, res) => {
    const { roomName, wallet, youtubeRtmpUrl } = req.body;
    const tenant = req.tenant;
    try {
        // 1. Tenant verification
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // 2. Input validation
        if (!roomName || !wallet || typeof wallet !== "string" || !youtubeRtmpUrl) {
            return res.status(400).json({
                error: "Missing required fields: room name, wallet, or YouTube RTMP URL",
            });
        }
        if (!isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Invalid wallet address format." });
        }
        if (!youtubeRtmpUrl.startsWith('rtmp://')) {
            return res.status(400).json({
                error: "Invalid YouTube RTMP URL format. Should start with rtmp://",
            });
        }
        // 3. Verify stream belongs to tenant and include user relationship
        const stream = await db.stream.findFirst({
            where: {
                name: roomName,
                tenantId: tenant.id,
            },
            include: {
                user: true,
            },
        });
        if (!stream) {
            return res
                .status(404)
                .json({ error: "Stream not found." });
        }
        // 4. Check if stream is already being recorded/streamed
        if (stream.recording) {
            return res.status(400).json({
                error: "Stream is already being recorded or streamed",
                recordId: stream.recordId,
            });
        }
        // 5. Get user and determine user type
        const user = await db.user.findFirst({
            where: {
                walletAddress: wallet,
                tenantId: tenant.id,
            },
        });
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
        // 6. Verify user has streaming privileges
        if (userType !== "host") {
            return res.status(403).json({
                error: "Only the host can stream to YouTube.",
            });
        }
        // 7. Start streaming to YouTube
        const egressService = new EgressClient(livekitHost, process.env.LIVEKIT_API_KEY || '', process.env.LIVEKIT_API_SECRET || '');
        // Create output configuration for YouTube
        const output = {
            stream: new StreamOutput({
                protocol: StreamProtocol.RTMP,
                urls: [youtubeRtmpUrl],
            }),
        };
        // Start room composite egress (streams the room composition to YouTube)
        const egressInfo = await egressService.startRoomCompositeEgress(roomName, output);
        if (!egressInfo) {
            return res
                .status(500)
                .json({ error: "Failed to start YouTube stream. Please try again" });
        }
        // Update stream record to reflect recording/streaming state
        await db.stream.update({
            where: { id: stream.id },
            data: {
                recording: true,
                recordId: egressInfo.egressId,
            },
        });
        res.status(201).json({
            message: "YouTube streaming started",
            recordingId: egressInfo.egressId,
            streamId: stream.id,
        });
    }
    catch (error) {
        console.error("Error starting YouTube stream:", error);
        res.status(500).json({
            error: "Internal server error",
            details: error instanceof Error ? error.message : String(error),
        });
    }
    finally {
        await db.$disconnect();
    }
};
/**
 * Controller for stopping a YouTube stream
 */
export const stopYoutubeStream = async (req, res) => {
    const { recordId, wallet } = req.body;
    const tenant = req.tenant;
    try {
        // 1. Tenant verification
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // 2. Input validation
        if (!recordId || !wallet || typeof wallet !== "string") {
            return res.status(400).json({
                error: "Missing required fields: recordId and wallet",
            });
        }
        if (!isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Invalid wallet address format." });
        }
        // 3. Find the stream with this recording/streaming session
        const stream = await db.stream.findFirst({
            where: {
                recordId,
                tenantId: tenant.id,
                recording: true,
            },
            include: {
                user: true,
            },
        });
        if (!stream) {
            return res.status(404).json({ error: "Active streaming session not found" });
        }
        // 4. Verify user permissions
        const user = await db.user.findFirst({
            where: {
                walletAddress: wallet,
                tenantId: tenant.id,
            },
        });
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
        // 5. Verify user has streaming privileges
        if (userType !== "host") {
            return res.status(403).json({
                error: "Only the host can stop YouTube streaming.",
            });
        }
        // 6. Stop the streaming
        const egressService = new EgressClient(livekitHost, process.env.LIVEKIT_API_KEY || '', process.env.LIVEKIT_API_SECRET || '');
        await egressService.stopEgress(recordId);
        // 7. Update stream record
        await db.stream.update({
            where: { id: stream.id },
            data: {
                recording: false,
            },
        });
        res.status(200).json({
            message: "YouTube streaming stopped successfully",
            streamId: stream.id,
            recordId: recordId,
        });
    }
    catch (error) {
        console.error("Error stopping YouTube stream:", error);
        res.status(500).json({
            error: "Internal server error",
            details: error instanceof Error ? error.message : String(error),
        });
    }
    finally {
        await db.$disconnect();
    }
};
