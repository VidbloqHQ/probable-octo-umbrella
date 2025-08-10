import { db, executeQuery, executeTransaction, trackQuery } from "../prisma.js";
import { isValidWalletAddress } from "../utils/index.js";
// Cache for poll results
const pollResultsCache = new Map();
const POLL_CACHE_TTL = 10000; // 10 seconds - short because polls are live
/**
 * Controller for submitting a poll vote - OPTIMIZED
 */
export const submitPollVote = async (req, res) => {
    const { agendaId, selectedOption, wallet } = req.body;
    const tenant = req.tenant;
    let success = false;
    try {
        // 1. Tenant verification
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // 2. Input validation
        if (!agendaId || !selectedOption || !wallet) {
            return res.status(400).json({
                error: "Missing required fields: agendaId, selectedOption, or wallet"
            });
        }
        if (!isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Invalid wallet address format." });
        }
        // 3. Get agenda with poll content and verify participant in parallel
        const [agenda, participant] = await Promise.all([
            executeQuery(() => db.agenda.findFirst({
                where: {
                    id: agendaId,
                    tenantId: tenant.id,
                    action: "Poll",
                },
                include: {
                    pollContent: true,
                    stream: {
                        select: { id: true }
                    }
                }
            }), { maxRetries: 2, timeout: 10000 }),
            executeQuery(() => db.participant.findFirst({
                where: {
                    walletAddress: wallet,
                    tenantId: tenant.id,
                    leftAt: null // Only active participants
                },
                select: {
                    id: true,
                    streamId: true
                }
            }), { maxRetries: 1, timeout: 5000 })
        ]);
        if (!agenda) {
            return res.status(404).json({
                error: "Poll not found",
                details: `Agenda ${agendaId} is not found or does not belong to your tenant`
            });
        }
        if (!agenda.pollContent) {
            return res.status(404).json({
                error: "Poll content not found",
                details: `Poll content for agenda ${agendaId} is missing`
            });
        }
        if (!participant || participant.streamId !== agenda.stream.id) {
            return res.status(403).json({
                error: "Only active stream participants can vote"
            });
        }
        // 5. Verify poll option is valid
        if (!agenda.pollContent.options.includes(selectedOption)) {
            return res.status(400).json({
                error: "Invalid poll option",
                validOptions: agenda.pollContent.options
            });
        }
        // 6. Check if participant has already voted
        const existingVote = await executeQuery(() => db.pollVote.findFirst({
            where: {
                pollContentId: agenda.pollContent.id,
                participantId: participant.id
            },
            select: {
                id: true,
                selectedOption: true
            }
        }), { maxRetries: 1, timeout: 5000 });
        if (existingVote) {
            return res.status(400).json({
                error: "You have already voted in this poll",
                previousVote: existingVote.selectedOption
            });
        }
        // 7. Record the vote using transaction for consistency
        await executeTransaction(async (tx) => {
            // Create the vote
            await tx.pollVote.create({
                data: {
                    pollContentId: agenda.pollContent.id,
                    selectedOption,
                    participantId: participant.id
                }
            });
            // Update total votes count
            await tx.pollContent.update({
                where: { id: agenda.pollContent.id },
                data: { totalVotes: { increment: 1 } }
            });
            // Create participant response record
            await tx.participantResponse.create({
                data: {
                    agendaId: agenda.id,
                    participantId: participant.id,
                    responseType: "poll_vote"
                }
            });
        }, { maxWait: 5000, timeout: 15000 });
        // Invalidate cache
        pollResultsCache.delete(agendaId);
        success = true;
        res.status(201).json({
            message: "Vote recorded successfully",
            selectedOption,
            agendaId,
            pollTitle: agenda.title
        });
    }
    catch (error) {
        console.error("Error submitting poll vote:", error);
        // Check for specific Prisma errors
        if (error.code === 'P2002') {
            return res.status(400).json({
                error: "You have already voted in this poll"
            });
        }
        if (error.code === 'P2024' || error.code === 'TIMEOUT') {
            return res.status(503).json({
                error: "Service temporarily unavailable. Please try again.",
                retry: true
            });
        }
        res.status(500).json({
            error: "Internal server error",
        });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for getting poll results - OPTIMIZED
 */
export const getPollResults = async (req, res) => {
    const { agendaId } = req.params;
    const tenant = req.tenant;
    let success = false;
    try {
        // 1. Tenant verification
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // 2. Input validation
        if (!agendaId) {
            return res.status(400).json({ error: "Missing agenda ID" });
        }
        // 3. Check cache first
        const cached = pollResultsCache.get(agendaId);
        if (cached && Date.now() - cached.timestamp < POLL_CACHE_TTL) {
            success = true;
            return res.status(200).json(cached.data);
        }
        // 4. Get poll with votes
        const agenda = await executeQuery(() => db.agenda.findFirst({
            where: {
                id: agendaId,
                tenantId: tenant.id,
                action: "Poll"
            },
            include: {
                pollContent: {
                    include: {
                        votes: {
                            select: {
                                selectedOption: true
                            }
                        }
                    }
                }
            }
        }), { maxRetries: 2, timeout: 10000 });
        if (!agenda || !agenda.pollContent) {
            return res.status(404).json({
                error: "Poll not found",
                details: `Agenda ${agendaId} is not a poll or does not exist`
            });
        }
        // 5. Calculate vote distribution efficiently
        const voteCounts = {};
        // Initialize all options with 0
        for (const option of agenda.pollContent.options) {
            voteCounts[option] = 0;
        }
        // Count votes
        for (const vote of agenda.pollContent.votes) {
            voteCounts[vote.selectedOption]++;
        }
        const result = {
            id: agenda.id,
            title: agenda.title,
            totalVotes: agenda.pollContent.totalVotes,
            options: agenda.pollContent.options,
            voteCounts
        };
        // Cache the results
        pollResultsCache.set(agendaId, {
            data: result,
            timestamp: Date.now()
        });
        success = true;
        res.status(200).json(result);
    }
    catch (error) {
        console.error("Error fetching poll results:", error);
        res.status(500).json({
            error: "Internal server error",
        });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for checking a participant's poll vote - OPTIMIZED
 */
export const getUserPollVote = async (req, res) => {
    const { agendaId } = req.params;
    const { wallet } = req.query;
    const tenant = req.tenant;
    let success = false;
    try {
        // 1. Tenant verification
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // 2. Input validation
        if (!agendaId) {
            return res.status(400).json({ error: "Missing agenda ID" });
        }
        if (!wallet || typeof wallet !== "string") {
            return res.status(400).json({ error: "Wallet address is required." });
        }
        if (!isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Invalid wallet address format." });
        }
        // 3. Get agenda and participant in parallel
        const [agenda, participant] = await Promise.all([
            executeQuery(() => db.agenda.findFirst({
                where: {
                    id: agendaId,
                    tenantId: tenant.id,
                    action: "Poll"
                },
                include: {
                    pollContent: {
                        select: {
                            id: true,
                            options: true
                        }
                    },
                    stream: {
                        select: { id: true }
                    }
                }
            }), { maxRetries: 2, timeout: 10000 }),
            executeQuery(() => db.participant.findFirst({
                where: {
                    walletAddress: wallet,
                    tenantId: tenant.id
                },
                select: {
                    id: true,
                    streamId: true
                }
            }), { maxRetries: 1, timeout: 5000 })
        ]);
        if (!agenda || !agenda.pollContent) {
            return res.status(404).json({
                error: "Poll not found",
                details: `Agenda ${agendaId} is not a poll or does not exist`
            });
        }
        if (!participant || participant.streamId !== agenda.stream.id) {
            return res.status(404).json({
                error: "Participant not found in this stream"
            });
        }
        // 5. Find vote
        const vote = await executeQuery(() => db.pollVote.findFirst({
            where: {
                pollContentId: agenda.pollContent.id,
                participantId: participant.id
            },
            select: {
                selectedOption: true
            }
        }), { maxRetries: 1, timeout: 5000 });
        success = true;
        res.status(200).json({
            hasVoted: !!vote,
            vote: vote ? vote.selectedOption : null,
            title: agenda.title,
            options: agenda.pollContent.options
        });
    }
    catch (error) {
        console.error("Error fetching user poll vote:", error);
        res.status(500).json({
            error: "Internal server error",
        });
    }
    finally {
        trackQuery(success);
    }
};
// Periodic cache cleanup
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of pollResultsCache.entries()) {
        if (now - value.timestamp > POLL_CACHE_TTL) {
            pollResultsCache.delete(key);
        }
    }
}, 30000); // Clean every 30 seconds
