import { db } from "../prisma.js";
import { isValidWalletAddress } from "../utils/index.js";
/**
 * Controller for submitting a poll vote
 */
// export const submitPollVote = async (req: TenantRequest, res: Response) => {
//   const { agendaId, selectedOption, wallet } = req.body;
//   const tenant = req.tenant;
//   try {
//     // 1. Tenant verification
//     if (!tenant) {
//       return res.status(401).json({ error: "Tenant authentication required." });
//     }
//     // 2. Input validation
//     if (!agendaId || !selectedOption || !wallet) {
//       return res.status(400).json({ 
//         error: "Missing required fields: agendaId, selectedOption, or wallet" 
//       });
//     }
//     if (!isValidWalletAddress(wallet)) {
//       return res.status(400).json({ error: "Invalid wallet address format." });
//     }
//     // 3. Verify agenda belongs to tenant and is a poll
//     const agenda = await db.agenda.findFirst({
//       where: {
//         id: agendaId,
//         tenantId: tenant.id,
//         action: "Poll",
//       },
//       include: {
//         pollContent: true,
//         stream: true
//       }
//     });
//     if (!agenda) {
//       return res.status(404).json({ 
//         error: "Poll not found",
//         details: `Agenda ${agendaId} is not found or does not belong to your tenant`
//       });
//     }
//     if (!agenda.pollContent) {
//       return res.status(404).json({ 
//         error: "Poll content not found",
//         details: `Poll content for agenda ${agendaId} is missing`
//       });
//     }
//     // 4. Verify participant
//     const participant = await db.participant.findFirst({
//       where: {
//         walletAddress: wallet,
//         streamId: agenda.stream.id,
//         tenantId: tenant.id,
//         leftAt: null // Only active participants can vote
//       }
//     });
//     if (!participant) {
//       return res.status(403).json({ 
//         error: "Only active stream participants can vote" 
//       });
//     }
//     // 5. Verify poll option is valid
//     if (!agenda.pollContent.options.includes(selectedOption)) {
//       return res.status(400).json({ 
//         error: "Invalid poll option",
//         validOptions: agenda.pollContent.options
//       });
//     }
//     // 6. Check if participant has already voted
//     const existingVote = await db.pollVote.findFirst({
//       where: {
//         pollContentId: agenda.pollContent.id,
//         participantId: participant.id
//       }
//     });
//     if (existingVote) {
//       return res.status(400).json({ 
//         error: "You have already voted in this poll",
//         previousVote: existingVote.selectedOption
//       });
//     }
//     // Store pollContent ID to avoid TS error with null checking
//     const pollContentId = agenda.pollContent.id;
//     // 7. Record the vote using a transaction
//     await db.$transaction(async (tx) => {
//       // Create the vote
//       await tx.pollVote.create({
//         data: {
//           pollContentId: pollContentId,
//           selectedOption,
//           participantId: participant.id
//         }
//       });
//       // Update total votes count
//       await tx.pollContent.update({
//         where: { id: pollContentId },
//         data: { totalVotes: { increment: 1 } }
//       });
//       // Create participant response record
//       await tx.participantResponse.create({
//         data: {
//           agendaId: agenda.id,
//           participantId: participant.id,
//           responseType: "poll_vote"
//         }
//       });
//     });
//     res.status(201).json({
//       message: "Vote recorded successfully",
//       selectedOption,
//       agendaId,
//       pollTitle: agenda.title
//     });
//   } catch (error) {
//     console.error("Error submitting poll vote:", error);
//     res.status(500).json({ 
//       error: "Internal server error",
//     });
//   } 
//   // finally {
//   //   await db.$disconnect();
//   // }
// };
/**
 * Controller for submitting a poll vote
 */
export const submitPollVote = async (req, res) => {
    const { agendaId, selectedOption, wallet } = req.body;
    const tenant = req.tenant;
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
        // 3. Verify agenda belongs to tenant and is a poll
        const agenda = await db.agenda.findFirst({
            where: {
                id: agendaId,
                tenantId: tenant.id,
                action: "Poll",
            },
            include: {
                pollContent: true,
                stream: true
            }
        });
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
        // 4. Verify participant
        const participant = await db.participant.findFirst({
            where: {
                walletAddress: wallet,
                streamId: agenda.stream.id,
                tenantId: tenant.id,
                leftAt: null // Only active participants can vote
            }
        });
        if (!participant) {
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
        const existingVote = await db.pollVote.findFirst({
            where: {
                pollContentId: agenda.pollContent.id,
                participantId: participant.id
            }
        });
        if (existingVote) {
            return res.status(400).json({
                error: "You have already voted in this poll",
                previousVote: existingVote.selectedOption
            });
        }
        // 7. Record the vote (without transaction)
        let pollVote;
        let participantResponse;
        try {
            // Create the vote
            pollVote = await db.pollVote.create({
                data: {
                    pollContentId: agenda.pollContent.id,
                    selectedOption,
                    participantId: participant.id
                }
            });
            // Update total votes count
            await db.pollContent.update({
                where: { id: agenda.pollContent.id },
                data: { totalVotes: { increment: 1 } }
            });
            // Create participant response record
            participantResponse = await db.participantResponse.create({
                data: {
                    agendaId: agenda.id,
                    participantId: participant.id,
                    responseType: "poll_vote"
                }
            });
        }
        catch (error) {
            // If any operation fails after vote creation, attempt cleanup
            if (pollVote) {
                try {
                    await db.pollVote.delete({
                        where: { id: pollVote.id }
                    });
                }
                catch (cleanupError) {
                    console.error("Failed to cleanup vote after error:", cleanupError);
                }
            }
            // Re-throw the original error
            throw error;
        }
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
        res.status(500).json({
            error: "Internal server error",
        });
    }
};
/**
 * Controller for getting poll results
 */
export const getPollResults = async (req, res) => {
    const { agendaId } = req.params;
    const tenant = req.tenant;
    try {
        // 1. Tenant verification
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // 2. Input validation
        if (!agendaId) {
            return res.status(400).json({ error: "Missing agenda ID" });
        }
        // 3. Verify agenda belongs to tenant and is a poll
        const agenda = await db.agenda.findFirst({
            where: {
                id: agendaId,
                tenantId: tenant.id,
                action: "Poll"
            },
            include: {
                pollContent: {
                    include: {
                        votes: true
                    }
                }
            }
        });
        if (!agenda || !agenda.pollContent) {
            return res.status(404).json({
                error: "Poll not found",
                details: `Agenda ${agendaId} is not a poll or does not exist`
            });
        }
        // 4. Calculate vote distribution
        const voteCounts = {};
        for (const option of agenda.pollContent.options) {
            voteCounts[option] = agenda.pollContent.votes.filter(vote => vote.selectedOption === option).length;
        }
        // 5. Return results
        res.status(200).json({
            id: agenda.id,
            title: agenda.title,
            totalVotes: agenda.pollContent.totalVotes,
            options: agenda.pollContent.options,
            voteCounts
        });
    }
    catch (error) {
        console.error("Error fetching poll results:", error);
        res.status(500).json({
            error: "Internal server error",
        });
    }
    finally {
        await db.$disconnect();
    }
};
/**
 * Controller for checking a participant's poll vote
 */
export const getUserPollVote = async (req, res) => {
    const { agendaId } = req.params;
    const { wallet } = req.query;
    const tenant = req.tenant;
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
        // 3. Verify agenda belongs to tenant and is a poll
        const agenda = await db.agenda.findFirst({
            where: {
                id: agendaId,
                tenantId: tenant.id,
                action: "Poll"
            },
            include: {
                pollContent: true,
                stream: true
            }
        });
        if (!agenda || !agenda.pollContent) {
            return res.status(404).json({
                error: "Poll not found",
                details: `Agenda ${agendaId} is not a poll or does not exist`
            });
        }
        // 4. Find participant
        const participant = await db.participant.findFirst({
            where: {
                walletAddress: wallet,
                streamId: agenda.stream.id,
                tenantId: tenant.id
            }
        });
        if (!participant) {
            return res.status(404).json({
                error: "Participant not found"
            });
        }
        // 5. Find vote
        const vote = await db.pollVote.findFirst({
            where: {
                pollContentId: agenda.pollContent.id,
                participantId: participant.id
            }
        });
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
        await db.$disconnect();
    }
};
