import { AgendaAction } from "@prisma/client";
import { db, executeQuery, trackQuery } from "../prisma.js";
import { isValidWalletAddress } from "../utils/index.js";
// Cache for stream and user authorization data
const authCache = new Map();
const AUTH_CACHE_TTL = 30000; // 30 seconds
// Helper to get cached or fetch authorization data
async function getAuthorizationData(streamId, wallet, tenantId) {
    const cacheKey = `${streamId}:${wallet}:${tenantId}`;
    const cached = authCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < AUTH_CACHE_TTL) {
        return cached.data;
    }
    // Parallel fetch stream and user data
    const [stream, requestingUser] = await Promise.all([
        db.stream.findFirst({
            where: {
                name: streamId,
                tenantId,
            },
            select: {
                id: true,
                userId: true,
                creatorWallet: true,
                isLive: true,
                participants: {
                    where: {
                        walletAddress: wallet,
                        userType: "co-host",
                        leftAt: null
                    },
                    select: { id: true }
                }
            }
        }),
        db.user.findFirst({
            where: {
                walletAddress: wallet,
                tenantId,
            },
            select: { id: true }
        })
    ]);
    const data = { stream, requestingUser };
    authCache.set(cacheKey, { data, timestamp: Date.now() });
    // Clean old cache entries
    if (authCache.size > 100) {
        const now = Date.now();
        for (const [key, value] of authCache.entries()) {
            if (now - value.timestamp > AUTH_CACHE_TTL) {
                authCache.delete(key);
            }
        }
    }
    return data;
}
/**
 * Controller for creating agenda items for a stream - OPTIMIZED VERSION
 */
// export const createAgenda = async (req: TenantRequest, res: Response) => {
//   const { streamId } = req.params; 
//   const { agendas, wallet } = req.body;
//   const tenant = req.tenant;
//   try {
//     // 1. Tenant verification
//     if (!tenant) {
//       return res.status(401).json({ error: "Tenant authentication required." });
//     }
//     // 2. Input validation
//     if (!streamId || !agendas || !wallet) {
//       return res.status(400).json({ 
//         error: "Missing required fields: streamId, agendas, or wallet" 
//       });
//     }
//     if (!isValidWalletAddress(wallet)) {
//       return res.status(400).json({ error: "Invalid wallet address format." });
//     }
//     // 3. Get authorization data (cached)
//     const { stream, requestingUser } = await getAuthorizationData(
//       streamId,
//       wallet,
//       tenant.id
//     );
//     // 4. Validate stream exists
//     if (!stream) {
//       return res.status(404).json({ 
//         error: "Stream not found",
//         details: `Stream ${streamId} not found`
//       });
//     }
//     // 5. Validate user exists
//     if (!requestingUser) {
//       return res.status(403).json({ error: "User not authorized." });
//     }
//     // 6. Check permissions (now with data already loaded)
//     const isHost = requestingUser.id === stream.userId;
//     const isCoHost = stream.participants && stream.participants.length > 0;
//     if (!isHost && !isCoHost) {
//       return res.status(403).json({ 
//         error: "Only hosts and co-hosts can create agendas",
//         requiredRole: "host or co-host"
//       });
//     }
//     // 7. Validate ALL agendas before any DB operations
//     const preparedAgendas: any[] = [];
//     for (const [index, agenda] of agendas.entries()) {
//       // Validate required agenda fields
//       if (typeof agenda.timeStamp !== 'number' || agenda.timeStamp < 0) {
//         return res.status(400).json({ 
//           error: `Agenda ${index + 1}: Invalid timeStamp (must be positive number)`,
//           agendaIndex: index
//         });
//       }
//       if (!agenda.action || typeof agenda.action !== 'string') {
//         return res.status(400).json({
//           error: `Agenda ${index + 1}: Action is required`,
//           agendaIndex: index
//         });
//       }
//       // Validate action enum
//       const actionInput = agenda.action;
//       if (!Object.values(AgendaAction).includes(actionInput as any)) {
//         return res.status(400).json({
//           error: `Agenda ${index + 1}: Invalid action type`,
//           validActions: Object.values(AgendaAction),
//           agendaIndex: index
//         });
//       }
//       const actionEnum = actionInput as AgendaAction;
//       // Validate title requirement based on action type
//       if ((actionEnum === AgendaAction.Poll || 
//            actionEnum === AgendaAction.Q_A || 
//            actionEnum === AgendaAction.Quiz || 
//            actionEnum === AgendaAction.Custom) && 
//           (!agenda.title || typeof agenda.title !== 'string')) {
//         return res.status(400).json({
//           error: `Agenda ${index + 1}: Title is required for ${actionEnum} agenda`,
//           agendaIndex: index
//         });
//       }
//       // Prepare agenda data based on type
//       const baseData = {
//         streamId: stream.id,
//         timeStamp: agenda.timeStamp,
//         action: actionEnum,
//         title: agenda.title || null,
//         description: agenda.description || null,
//         duration: agenda.duration || null,
//         tenantId: tenant.id,
//       };
//       switch (actionEnum) {
//         case AgendaAction.Poll:
//           if (!agenda.options || !Array.isArray(agenda.options) || agenda.options.length < 2) {
//             return res.status(400).json({
//               error: `Agenda ${index + 1}: Poll requires at least 2 options`,
//               agendaIndex: index
//             });
//           }
//           preparedAgendas.push({
//             ...baseData,
//             pollContent: {
//               create: {
//                 options: agenda.options,
//                 totalVotes: 0
//               }
//             }
//           });
//           break;
//         case AgendaAction.Quiz:
//           if (!agenda.questions || !Array.isArray(agenda.questions) || agenda.questions.length < 1) {
//             return res.status(400).json({
//               error: `Agenda ${index + 1}: Quiz requires at least 1 question`,
//               agendaIndex: index
//             });
//           }
//           // Validate all questions
//           for (const question of agenda.questions) {
//             if (!question.questionText || !question.options || !question.correctAnswer) {
//               return res.status(400).json({
//                 error: `Agenda ${index + 1}: Each quiz question requires questionText, options, and correctAnswer`,
//                 agendaIndex: index
//               });
//             }
//           }
//           preparedAgendas.push({
//             ...baseData,
//             quizContent: {
//               create: {
//                 questions: {
//                   create: agenda.questions.map((q: any) => ({
//                     questionText: q.questionText,
//                     options: q.options,
//                     correctAnswer: q.correctAnswer,
//                     isMultiChoice: q.isMultiChoice ?? true,
//                     points: q.points ?? 1
//                   }))
//                 }
//               }
//             }
//           });
//           break;
//         case AgendaAction.Q_A:
//           preparedAgendas.push({
//             ...baseData,
//             qaContent: {
//               create: {
//                 topic: agenda.topic || agenda.title || null
//               }
//             }
//           });
//           break;
//         case AgendaAction.Custom:
//         default:
//           preparedAgendas.push({
//             ...baseData,
//             customContent: {
//               create: {
//                 customData: agenda.customData || {}
//               }
//             }
//           });
//           break;
//       }
//     }
//     // 8. Create all agendas in a single transaction for consistency
//     const createdAgendas = await db.$transaction(
//       preparedAgendas.map(agendaData => 
//         db.agenda.create({
//           data: agendaData,
//           include: {
//             pollContent: true,
//             quizContent: {
//               include: { questions: true }
//             },
//             qaContent: true,
//             customContent: true
//           }
//         })
//       )
//     );
//     res.status(201).json(createdAgendas);
//   } catch (error) {
//     console.error("Error creating agenda:", error);
//     // More detailed error response for debugging
//     if (process.env.NODE_ENV === 'development') {
//       res.status(500).json({ 
//         error: "Internal server error",
//         details: error instanceof Error ? error.message : 'Unknown error',
//         stack: error instanceof Error ? error.stack : undefined
//       });
//     } else {
//       res.status(500).json({ 
//         error: "Internal server error"
//       });
//     }
//   }
// };
/**
 * Controller for creating agenda items - REFACTORED WITHOUT TRANSACTIONS
 */
export const createAgenda = async (req, res) => {
    const { streamId } = req.params;
    const { agendas, wallet } = req.body;
    const tenant = req.tenant;
    let success = false;
    try {
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!streamId || !agendas || !wallet) {
            return res.status(400).json({
                error: "Missing required fields: streamId, agendas, or wallet"
            });
        }
        if (!isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Invalid wallet address format." });
        }
        // Get authorization data
        const [stream, requestingUser] = await Promise.all([
            executeQuery(() => db.stream.findFirst({
                where: {
                    name: streamId,
                    tenantId: tenant.id,
                },
                select: {
                    id: true,
                    userId: true,
                    creatorWallet: true,
                    isLive: true,
                }
            }), { maxRetries: 2, timeout: 5000 }),
            executeQuery(() => db.user.findFirst({
                where: {
                    walletAddress: wallet,
                    tenantId: tenant.id,
                },
                select: { id: true }
            }), { maxRetries: 2, timeout: 5000 })
        ]);
        if (!stream) {
            return res.status(404).json({
                error: "Stream not found",
                details: `Stream ${streamId} not found`
            });
        }
        if (!requestingUser) {
            return res.status(403).json({ error: "User not authorized." });
        }
        // Check permissions
        const isHost = requestingUser.id === stream.userId;
        const isCoHost = await executeQuery(() => db.participant.findFirst({
            where: {
                walletAddress: wallet,
                streamId: stream.id,
                userType: "co-host",
                tenantId: tenant.id,
                leftAt: null
            },
            select: { id: true }
        }), { maxRetries: 1, timeout: 3000 });
        if (!isHost && !isCoHost) {
            return res.status(403).json({
                error: "Only hosts and co-hosts can create agendas",
                requiredRole: "host or co-host"
            });
        }
        // Create agendas individually (not in transaction)
        const createdAgendas = [];
        const failedAgendas = [];
        for (const [index, agenda] of agendas.entries()) {
            try {
                // Validate agenda
                if (typeof agenda.timeStamp !== 'number' || agenda.timeStamp < 0) {
                    throw new Error(`Invalid timeStamp (must be positive number)`);
                }
                if (!agenda.action || !Object.values(AgendaAction).includes(agenda.action)) {
                    throw new Error(`Invalid action type`);
                }
                const actionEnum = agenda.action;
                // Base agenda data
                const baseAgendaData = {
                    streamId: stream.id,
                    timeStamp: agenda.timeStamp,
                    action: actionEnum,
                    title: agenda.title || null,
                    description: agenda.description || null,
                    duration: agenda.duration || null,
                    tenantId: tenant.id,
                };
                let createdAgenda;
                // Create based on type
                switch (actionEnum) {
                    case AgendaAction.Poll:
                        if (!agenda.options || !Array.isArray(agenda.options) || agenda.options.length < 2) {
                            throw new Error(`Poll requires at least 2 options`);
                        }
                        // Create agenda first
                        createdAgenda = await executeQuery(() => db.agenda.create({
                            data: baseAgendaData,
                            include: { pollContent: true }
                        }), { maxRetries: 2, timeout: 5000 });
                        // Then create poll content
                        await executeQuery(() => db.pollContent.create({
                            data: {
                                agendaId: createdAgenda.id,
                                options: agenda.options,
                                totalVotes: 0
                            }
                        }), { maxRetries: 2, timeout: 5000 });
                        break;
                    case AgendaAction.Quiz:
                        if (!agenda.questions || !Array.isArray(agenda.questions) || agenda.questions.length < 1) {
                            throw new Error(`Quiz requires at least 1 question`);
                        }
                        // Create agenda first
                        createdAgenda = await executeQuery(() => db.agenda.create({
                            data: baseAgendaData,
                            include: { quizContent: true }
                        }), { maxRetries: 2, timeout: 5000 });
                        // Create quiz content
                        const quizContent = await executeQuery(() => db.quizContent.create({
                            data: {
                                agendaId: createdAgenda.id
                            }
                        }), { maxRetries: 2, timeout: 5000 });
                        // Create questions individually
                        for (const question of agenda.questions) {
                            await executeQuery(() => db.quizQuestion.create({
                                data: {
                                    quizContentId: quizContent.id,
                                    questionText: question.questionText,
                                    options: question.options,
                                    correctAnswer: question.correctAnswer,
                                    isMultiChoice: question.isMultiChoice ?? true,
                                    points: question.points ?? 1
                                }
                            }), { maxRetries: 1, timeout: 3000 }).catch(err => {
                                console.error(`Failed to create quiz question: ${err.message}`);
                            });
                        }
                        break;
                    case AgendaAction.Q_A:
                        createdAgenda = await executeQuery(() => db.agenda.create({
                            data: baseAgendaData,
                            include: { qaContent: true }
                        }), { maxRetries: 2, timeout: 5000 });
                        await executeQuery(() => db.qAContent.create({
                            data: {
                                agendaId: createdAgenda.id,
                                topic: agenda.topic || agenda.title || null
                            }
                        }), { maxRetries: 2, timeout: 5000 });
                        break;
                    case AgendaAction.Custom:
                    default:
                        createdAgenda = await executeQuery(() => db.agenda.create({
                            data: baseAgendaData,
                            include: { customContent: true }
                        }), { maxRetries: 2, timeout: 5000 });
                        await executeQuery(() => db.customContent.create({
                            data: {
                                agendaId: createdAgenda.id,
                                customData: agenda.customData || {}
                            }
                        }), { maxRetries: 2, timeout: 5000 });
                        break;
                }
                // Fetch complete agenda with all relations
                const completeAgenda = await executeQuery(() => db.agenda.findUnique({
                    where: { id: createdAgenda.id },
                    include: {
                        pollContent: true,
                        quizContent: {
                            include: { questions: true }
                        },
                        qaContent: true,
                        customContent: true
                    }
                }), { maxRetries: 1, timeout: 3000 });
                createdAgendas.push(completeAgenda);
            }
            catch (error) {
                console.error(`Failed to create agenda ${index + 1}:`, error);
                failedAgendas.push({
                    index,
                    error: error.message
                });
            }
        }
        // Return appropriate response
        if (createdAgendas.length === 0) {
            return res.status(400).json({
                error: "Failed to create any agendas",
                failures: failedAgendas
            });
        }
        if (failedAgendas.length > 0) {
            // Partial success
            success = true;
            return res.status(207).json({
                created: createdAgendas,
                failed: failedAgendas,
                message: `Created ${createdAgendas.length} of ${agendas.length} agendas`
            });
        }
        // Complete success
        success = true;
        res.status(201).json(createdAgendas);
    }
    catch (error) {
        console.error("Error creating agenda:", error);
        res.status(500).json({
            error: "Internal server error"
        });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for getting all stream's agendas - OPTIMIZED
 */
export const getStreamAgenda = async (req, res) => {
    const { streamId } = req.params;
    const tenant = req.tenant;
    try {
        // Tenant check
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!streamId) {
            return res.status(400).json({ error: "Missing livestream ID" });
        }
        // Get stream and its agendas
        // const stream = await db.stream.findFirst({
        //   where: {
        //     name: streamId,
        //     tenantId: tenant.id,
        //   },
        //   include: {
        //     agenda: {
        //       include: {
        //         pollContent: true,
        //         quizContent: {
        //           include: { questions: true }
        //         },
        //         qaContent: true,
        //         customContent: true,
        //         participantResponses: {
        //           select: {
        //             id: true,
        //             responseType: true,
        //             timestamp: true,
        //             participantId: true
        //           }
        //         }
        //       },
        //       orderBy: {
        //         timeStamp: 'asc'
        //       }
        //     }
        //   }
        // });
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
                            include: { questions: true }
                        },
                        qaContent: true,
                        customContent: true,
                        participantResponses: {
                            select: {
                                id: true,
                                responseType: true,
                                timestamp: true,
                                participantId: true
                            }
                        }
                    },
                    orderBy: {
                        timeStamp: 'asc'
                    }
                }
            }
        }), { maxRetries: 2, timeout: 5000 });
        if (!stream) {
            return res
                .status(404)
                .json({ error: "Stream not found in your tenant" });
        }
        res.status(200).json(stream.agenda);
    }
    catch (error) {
        console.error("Error fetching agendas:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};
/**
 * Controller for updating a stream's agenda - OPTIMIZED
 */
export const updateStreamAgenda = async (req, res) => {
    const { agendaId } = req.params;
    const { title, description, timeStamp, wallet, action, isCompleted, ...contentUpdates } = req.body;
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
            return res.status(400).json({ error: "Valid wallet address is required." });
        }
        if (!isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Invalid wallet address format." });
        }
        // 3. Get agenda with minimal required relations
        const existingAgenda = await db.agenda.findFirst({
            where: {
                id: agendaId,
                tenantId: tenant.id,
            },
            select: {
                id: true,
                action: true,
                streamId: true,
                stream: {
                    select: {
                        id: true,
                        userId: true,
                        creatorWallet: true,
                        isLive: true
                    }
                },
                pollContent: {
                    select: {
                        id: true,
                        totalVotes: true
                    }
                },
                quizContent: {
                    select: {
                        id: true
                    }
                }
            }
        });
        if (!existingAgenda) {
            return res.status(404).json({
                error: "Agenda not found",
                details: `Agenda ${agendaId} not found`
            });
        }
        // 4. Prevent changing the action type of an existing agenda
        if (action !== undefined && action !== existingAgenda.action) {
            return res.status(400).json({
                error: "Cannot change agenda action type",
                currentType: existingAgenda.action,
                requestedType: action
            });
        }
        // 5. Validate that content updates match the agenda type
        const invalidFieldsForType = getInvalidFieldsForAgendaType(existingAgenda.action, contentUpdates);
        if (invalidFieldsForType.length > 0) {
            return res.status(400).json({
                error: "Content updates do not match agenda type",
                agendaType: existingAgenda.action,
                invalidFields: invalidFieldsForType
            });
        }
        // 6. Verify requesting user is authorized (use cached if possible)
        const { requestingUser } = await getAuthorizationData(existingAgenda.stream.id, wallet, tenant.id);
        if (!requestingUser) {
            return res.status(403).json({ error: "User not authorized." });
        }
        const isHost = requestingUser.id === existingAgenda.stream.userId;
        const isHostWallet = existingAgenda.stream.creatorWallet === wallet;
        // Only check co-host if not host
        if (!isHost && !isHostWallet) {
            const isCoHost = await db.participant.findFirst({
                where: {
                    walletAddress: wallet,
                    streamId: existingAgenda.stream.id,
                    userType: "co-host",
                    tenantId: tenant.id,
                    leftAt: null
                },
                select: { id: true }
            });
            if (!isCoHost) {
                return res.status(403).json({
                    error: "Only hosts and co-hosts can update agendas",
                    requiredRole: "host or co-host"
                });
            }
        }
        // 7. Check if update is allowed based on stream status
        const isLive = existingAgenda.stream.isLive;
        // Prepare base update data
        const updateData = {};
        // Base agenda fields that can always be updated
        if (title !== undefined) {
            // Title validation based on action type
            if ((existingAgenda.action === AgendaAction.Poll ||
                existingAgenda.action === AgendaAction.Q_A ||
                existingAgenda.action === AgendaAction.Quiz ||
                existingAgenda.action === AgendaAction.Custom) &&
                (!title || typeof title !== 'string')) {
                return res.status(400).json({
                    error: `Title is required for ${existingAgenda.action} agenda type`
                });
            }
            updateData.title = title;
        }
        if (description !== undefined) {
            updateData.description = description;
        }
        // Handle isCompleted field
        if (isCompleted !== undefined) {
            if (typeof isCompleted !== 'boolean') {
                return res.status(400).json({
                    error: "isCompleted must be a boolean value"
                });
            }
            updateData.isCompleted = isCompleted;
        }
        // Fields that can only be updated if stream is not live
        if (!isLive) {
            if (timeStamp !== undefined) {
                if (typeof timeStamp !== 'number' || timeStamp < 0) {
                    return res.status(400).json({
                        error: "Invalid timeStamp (must be positive number)"
                    });
                }
                updateData.timeStamp = timeStamp;
            }
        }
        else if (timeStamp !== undefined) {
            return res.status(400).json({
                error: "Cannot update timeStamp when stream is live"
            });
        }
        // 8. Handle content-specific updates with enhanced validation
        let contentUpdate = {};
        switch (existingAgenda.action) {
            case AgendaAction.Poll:
                if (contentUpdates.options) {
                    if (!Array.isArray(contentUpdates.options) || contentUpdates.options.length < 2) {
                        return res.status(400).json({ error: "Poll requires at least 2 options" });
                    }
                    // Only allow updating options if no votes have been cast yet
                    if (existingAgenda.pollContent && existingAgenda.pollContent.totalVotes > 0) {
                        return res.status(400).json({
                            error: "Cannot update poll options after voting has started"
                        });
                    }
                    contentUpdate = {
                        pollContent: {
                            update: {
                                options: contentUpdates.options
                            }
                        }
                    };
                }
                break;
            case AgendaAction.Quiz:
                // For quiz updates, add questions instead of replacing them
                if (contentUpdates.questions && Array.isArray(contentUpdates.questions)) {
                    // Check if there are already quiz responses
                    const hasResponses = await db.quizResponse.findFirst({
                        where: {
                            question: {
                                quizContentId: existingAgenda.quizContent?.id
                            }
                        },
                        select: { id: true }
                    });
                    if (hasResponses) {
                        return res.status(400).json({
                            error: "Cannot add new questions after quiz responses have been submitted"
                        });
                    }
                    // Validate all questions before adding them
                    for (const question of contentUpdates.questions) {
                        if (!question.questionText || !question.options || !question.correctAnswer) {
                            return res.status(400).json({
                                error: "Each quiz question requires questionText, options, and correctAnswer"
                            });
                        }
                        if (!Array.isArray(question.options) || question.options.length < 2) {
                            return res.status(400).json({
                                error: "Each quiz question requires at least 2 options"
                            });
                        }
                        if (!question.options.includes(question.correctAnswer)) {
                            return res.status(400).json({
                                error: "Correct answer must be one of the options"
                            });
                        }
                    }
                    // Add new questions in a transaction
                    if (existingAgenda.quizContent?.id) {
                        await db.$transaction(contentUpdates.questions.map((question) => db.quizQuestion.create({
                            data: {
                                quizContentId: existingAgenda.quizContent.id,
                                questionText: question.questionText,
                                options: question.options,
                                correctAnswer: question.correctAnswer,
                                isMultiChoice: question.isMultiChoice ?? true,
                                points: question.points ?? 1
                            }
                        })));
                    }
                }
                break;
            case AgendaAction.Q_A:
                if (contentUpdates.topic) {
                    if (typeof contentUpdates.topic !== 'string') {
                        return res.status(400).json({ error: "Topic must be a string" });
                    }
                    contentUpdate = {
                        qaContent: {
                            update: {
                                topic: contentUpdates.topic
                            }
                        }
                    };
                }
                break;
            case AgendaAction.Custom:
                if (contentUpdates.customData) {
                    // Validate customData is a proper object
                    if (typeof contentUpdates.customData !== 'object' || contentUpdates.customData === null) {
                        return res.status(400).json({ error: "customData must be a valid object" });
                    }
                    contentUpdate = {
                        customContent: {
                            update: {
                                customData: contentUpdates.customData
                            }
                        }
                    };
                }
                break;
        }
        // Merge content update with base update
        const finalUpdate = { ...updateData, ...contentUpdate };
        // Check if we have anything to update
        if (Object.keys(finalUpdate).length === 0) {
            return res.status(400).json({ error: "No valid update fields provided" });
        }
        // Perform the update
        const updatedAgenda = await db.agenda.update({
            where: { id: agendaId },
            data: finalUpdate,
            include: {
                pollContent: true,
                quizContent: {
                    include: { questions: true }
                },
                qaContent: true,
                customContent: true
            }
        });
        res.status(200).json(updatedAgenda);
    }
    catch (error) {
        console.error("Error updating agenda:", error);
        // Handle specific transaction errors
        if (error instanceof Error) {
            return res.status(400).json({
                error: error.message
            });
        }
        res.status(500).json({
            error: "Internal server error",
        });
    }
};
/**
 * Controller for deleting a stream's agenda - OPTIMIZED
 */
// export const deleteAgenda = async (req: TenantRequest, res: Response) => {
//   const { agendaId, wallet } = req.params;
//   const tenant = req.tenant;
//   try {
//     // 1. Tenant verification
//     if (!tenant) {
//       return res.status(401).json({ error: "Tenant authentication required." });
//     }
//     // 2. Input validation
//     if (!agendaId) {
//       return res.status(400).json({ error: "Missing agenda ID" });
//     }
//     if (!wallet || typeof wallet !== "string") {
//       return res.status(400).json({ error: "Valid wallet address is required." });
//     }
//     if (!isValidWalletAddress(wallet)) {
//       return res.status(400).json({ error: "Invalid wallet address format." });
//     }
//     // 3. Get agenda with minimal required data
//     const existingAgenda = await db.agenda.findFirst({
//       where: {
//         id: agendaId,
//         tenantId: tenant.id,
//       },
//       select: {
//         id: true,
//         streamId: true,
//         stream: {
//           select: {
//             id: true,
//             name: true,
//             userId: true
//           }
//         }
//       }
//     });
//     if (!existingAgenda) {
//       return res.status(404).json({ 
//         error: "Agenda not found",
//         details: `Agenda ${agendaId} not found`
//       });
//     }
//     // 4. Verify requesting user has permissions (use cached auth)
//     const { requestingUser } = await getAuthorizationData(
//       existingAgenda.stream.name,
//       wallet,
//       tenant.id
//     );
//     if (!requestingUser) {
//       return res.status(403).json({ error: "User not authorized." });
//     }
//     const isHost = requestingUser.id === existingAgenda.stream.userId;
//     if (!isHost) {
//       const isCoHost = await db.participant.findFirst({
//         where: {
//           walletAddress: wallet,
//           streamId: existingAgenda.stream.id,
//           userType: "co-host",
//           tenantId: tenant.id,
//           leftAt: null
//         },
//         select: { id: true }
//       });
//       if (!isCoHost) {
//         return res.status(403).json({ 
//           error: "Only hosts and co-hosts can delete agendas",
//           requiredRole: "host or co-host"
//         });
//       }
//     }
//     // 5. Delete agenda (cascade will handle all related content)
//     await db.agenda.delete({
//       where: { id: agendaId },
//     });
//     res.status(200).json({
//       message: "Agenda deleted successfully",
//       deletedId: agendaId,
//       livestreamId: existingAgenda.stream.name
//     });
//   } catch (error) {
//     console.error("Error deleting agenda:", error);
//     res.status(500).json({ 
//       error: "Internal server error",
//     });
//   }
// };
/**
 * Controller for deleting agenda - REFACTORED WITH COMPENSATION
 */
export const deleteAgenda = async (req, res) => {
    const { agendaId, wallet } = req.params;
    const tenant = req.tenant;
    let success = false;
    try {
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!agendaId || !wallet || !isValidWalletAddress(wallet)) {
            return res.status(400).json({ error: "Invalid parameters" });
        }
        // Get agenda
        const existingAgenda = await executeQuery(() => db.agenda.findFirst({
            where: {
                id: agendaId,
                tenantId: tenant.id,
            },
            select: {
                id: true,
                streamId: true,
                action: true,
                stream: {
                    select: {
                        id: true,
                        name: true,
                        userId: true
                    }
                }
            }
        }), { maxRetries: 2, timeout: 5000 });
        if (!existingAgenda) {
            return res.status(404).json({
                error: "Agenda not found",
                details: `Agenda ${agendaId} not found`
            });
        }
        // Verify permissions
        const requestingUser = await executeQuery(() => db.user.findFirst({
            where: {
                walletAddress: wallet,
                tenantId: tenant.id
            },
            select: { id: true }
        }), { maxRetries: 1, timeout: 3000 });
        if (!requestingUser) {
            return res.status(403).json({ error: "User not authorized." });
        }
        const isHost = requestingUser.id === existingAgenda.stream.userId;
        if (!isHost) {
            const isCoHost = await executeQuery(() => db.participant.findFirst({
                where: {
                    walletAddress: wallet,
                    streamId: existingAgenda.stream.id,
                    userType: "co-host",
                    tenantId: tenant.id,
                    leftAt: null
                },
                select: { id: true }
            }), { maxRetries: 1, timeout: 3000 });
            if (!isCoHost) {
                return res.status(403).json({
                    error: "Only hosts and co-hosts can delete agendas",
                    requiredRole: "host or co-host"
                });
            }
        }
        // Delete agenda (cascade will handle related content)
        await executeQuery(() => db.agenda.delete({
            where: { id: agendaId },
        }), { maxRetries: 2, timeout: 5000 });
        success = true;
        res.status(200).json({
            message: "Agenda deleted successfully",
            deletedId: agendaId,
            livestreamId: existingAgenda.stream.name
        });
    }
    catch (error) {
        console.error("Error deleting agenda:", error);
        res.status(500).json({
            error: "Internal server error",
        });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Controller for getting a specific agenda by ID - OPTIMIZED
 */
export const getAgenda = async (req, res) => {
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
        // 3. Get agenda with all content types and verify tenant ownership
        const agenda = await db.agenda.findFirst({
            where: {
                id: agendaId,
                tenantId: tenant.id,
            },
            include: {
                pollContent: true,
                quizContent: {
                    include: { questions: true }
                },
                qaContent: true,
                customContent: true,
                participantResponses: {
                    select: {
                        id: true,
                        responseType: true,
                        timestamp: true,
                        participantId: true
                    }
                },
                stream: {
                    select: {
                        id: true,
                        name: true,
                        isLive: true,
                        userId: true,
                        creatorWallet: true
                    }
                }
            },
        });
        if (!agenda) {
            return res.status(404).json({
                error: "Agenda not found",
                details: `Agenda ${agendaId} not found in your tenant`
            });
        }
        res.status(200).json(agenda);
    }
    catch (error) {
        console.error("Error fetching agenda:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};
/**
 * Helper function to validate content updates match the agenda type
 */
function getInvalidFieldsForAgendaType(actionType, contentUpdates) {
    const invalidFields = [];
    // Define valid fields for each action type
    const validFields = {
        [AgendaAction.Poll]: ['options'],
        [AgendaAction.Quiz]: ['questions'],
        [AgendaAction.Q_A]: ['topic'],
        [AgendaAction.Custom]: ['customData']
    };
    // Check for fields that don't belong to this agenda type
    const contentKeys = Object.keys(contentUpdates).filter(key => key !== 'title' && key !== 'description' && key !== 'timeStamp' && key !== 'wallet' && key !== 'isCompleted');
    for (const key of contentKeys) {
        if (!validFields[actionType]?.includes(key)) {
            invalidFields.push(key);
        }
    }
    return invalidFields;
}
