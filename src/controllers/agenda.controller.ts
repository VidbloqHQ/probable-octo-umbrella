import { Response } from "express";
import { AgendaAction } from "@prisma/client";
import { db } from "../prisma.js";
import { TenantRequest } from "../types/index.js";
import { isValidWalletAddress } from "../utils/index.js";

/**
 * Controller for creating a agenda items for a stream
 */
export const createAgenda = async (req: TenantRequest, res: Response) => {
  const { streamId } = req.params; 
  const { agendas, wallet } = req.body;
  const tenant = req.tenant;
  const streamAgendas = [];

  try {
    // 1. Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    // 2. Input validation
    if (!streamId || !agendas || !wallet) {
      return res.status(400).json({ 
        error: "Missing required fields: streamId, agendas, or wallet" 
      });
    }

    if (!isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    // 3. Verify livestream belongs to tenant and include user relation
    const stream = await db.stream.findFirst({
      where: {
        name: streamId,
        tenantId: tenant.id,
      },
      include: {
        user: true // Needed for host verification
      }
    });

    if (!stream) {
      return res.status(404).json({ 
        error: "Stream not found",
        details: `Stream ${streamId} not found`
      });
    }

    // 4. Verify requesting user permissions
    const requestingUser = await db.user.findFirst({
      where: {
        walletAddress: wallet,
        tenantId: tenant.id,
      },
    });

    if (!requestingUser) {
      return res.status(403).json({ error: "User not authorized." });
    }

    // 5. Check if user is host or co-host
    const isHost = requestingUser.id === stream.userId;
    const isCoHost = await db.participant.findFirst({
      where: {
        walletAddress: wallet,
        streamId: stream.id,
        userType: "co-host",
        tenantId: tenant.id,
        leftAt: null // Only active participants
      }
    });

    if (!isHost && !isCoHost) {
      return res.status(403).json({ 
        error: "Only hosts and co-hosts can create agendas",
        requiredRole: "host or co-host"
      });
    }

    // 6. Validate and process agendas
    for (const [index, agenda] of agendas.entries()) {
      // Validate required agenda fields
      if (typeof agenda.timeStamp !== 'number' || agenda.timeStamp < 0) {
        return res.status(400).json({ 
          error: `Agenda ${index + 1}: Invalid timeStamp (must be positive number)`,
          agendaIndex: index
        });
      }

      if (!agenda.action || typeof agenda.action !== 'string') {
        return res.status(400).json({
          error: `Agenda ${index + 1}: Action is required`,
          agendaIndex: index
        });
      }

      // Validate action enum
      const actionInput = agenda.action;
      if (!Object.values(AgendaAction).includes(actionInput as any)) {
        return res.status(400).json({
          error: `Agenda ${index + 1}: Invalid action type`,
          validActions: Object.values(AgendaAction),
          agendaIndex: index
        });
      }
      const actionEnum = actionInput as AgendaAction;

      // Validate title requirement based on action type
      if ((actionEnum === AgendaAction.Poll || 
           actionEnum === AgendaAction.Q_A || 
           actionEnum === AgendaAction.Quiz || 
           actionEnum === AgendaAction.Custom) && 
          (!agenda.title || typeof agenda.title !== 'string')) {
        return res.status(400).json({
          error: `Agenda ${index + 1}: Title is required for ${actionEnum} agenda`,
          agendaIndex: index
        });
      }

      // Base agenda data
      const agendaData = {
        streamId: stream.id,
        timeStamp: agenda.timeStamp,
        action: actionEnum,
        title: agenda.title || null, // Allow null for actions that don't require title
        description: agenda.description || null,
        duration: agenda.duration || null,
        tenantId: tenant.id,
      };

      // Create different content based on action type
      let agendaRes;
      switch (actionEnum) {
        case AgendaAction.Poll:
          if (!agenda.options || !Array.isArray(agenda.options) || agenda.options.length < 2) {
            return res.status(400).json({
              error: `Agenda ${index + 1}: Poll requires at least 2 options`,
              agendaIndex: index
            });
          }

          agendaRes = await db.agenda.create({
            data: {
              ...agendaData,
              pollContent: {
                create: {
                  options: agenda.options,
                  totalVotes: 0
                }
              }
            },
            include: { pollContent: true }
          });
          break;

        case AgendaAction.Quiz:
          if (!agenda.questions || !Array.isArray(agenda.questions) || agenda.questions.length < 1) {
            return res.status(400).json({
              error: `Agenda ${index + 1}: Quiz requires at least 1 question`,
              agendaIndex: index
            });
          }

          const quiz = await db.agenda.create({
            data: {
              ...agendaData,
              quizContent: {
                create: {}
              }
            },
            include: { quizContent: true }
          });

          // Add questions to the quiz
          for (const question of agenda.questions) {
            if (!question.questionText || !question.options || !question.correctAnswer) {
              return res.status(400).json({
                error: `Agenda ${index + 1}: Each quiz question requires questionText, options, and correctAnswer`,
                agendaIndex: index
              });
            }

            await db.quizQuestion.create({
              data: {
                quizContentId: quiz.quizContent!.id,
                questionText: question.questionText,
                options: question.options,
                correctAnswer: question.correctAnswer,
                isMultiChoice: question.isMultiChoice ?? true,
                points: question.points ?? 1
              }
            });
          }

          // Fetch the complete quiz with questions
          agendaRes = await db.agenda.findUnique({
            where: { id: quiz.id },
            include: { 
              quizContent: {
                include: { questions: true }
              }
            }
          });
          break;

        case AgendaAction.Q_A:
          agendaRes = await db.agenda.create({
            data: {
              ...agendaData,
              qaContent: {
                create: {
                  // Use title as topic if no specific topic is provided
                  topic: agenda.topic || agenda.title || null
                }
              }
            },
            include: { qaContent: true }
          });
          break;

        case AgendaAction.Custom:
        default:
          agendaRes = await db.agenda.create({
            data: {
              ...agendaData,
              customContent: {
                create: {
                  customData: agenda.customData || {}
                }
              }
            },
            include: { customContent: true }
          });
          break;
      }

      streamAgendas.push(agendaRes);
    }

    res.status(201).json(streamAgendas);
  } catch (error) {
    console.error("Error creating agenda:", error);
    res.status(500).json({ 
      error: "Internal server error",
    });
  } finally {
    await db.$disconnect();
  }
};

/**
 * Controller for getting all liveStream's agendas
 */
export const getStreamAgenda = async (
  req: TenantRequest,
  res: Response
) => {
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

    // Verify stream belongs to tenant
    const stream = await db.stream.findFirst({
      where: {
        name: streamId,
        tenantId: tenant.id,
      },
    });

    if (!stream) {
      return res
        .status(404)
        .json({ error: "Stream not found in your tenant" });
    }

    // Get tenant-scoped agendas with all content types
    const allAgenda = await db.agenda.findMany({
      where: {
        streamId: stream.id,
        tenantId: tenant.id,
      },
      include: {
        pollContent: true,
        quizContent: {
          include: { questions: true }
        },
        qaContent: true,
        customContent: true,
        participantResponses: true
      },
    });

    res.status(200).json(allAgenda);
  } catch (error) {
    console.error("Error fetching agendas:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await db.$disconnect();
  }
};

/**
 * Controller for updating a liveStream's agenda
 */
export const updateStreamAgenda = async (
  req: TenantRequest,
  res: Response
) => {
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

    // 3. Get agenda with all required relations
    const existingAgenda = await db.agenda.findFirst({
      where: {
        id: agendaId,
        tenantId: tenant.id,
      },
      include: {
        stream: {
          include: {
            user: true
          }
        },
        pollContent: true,
        quizContent: {
          include: { questions: true }
        },
        qaContent: true,
        customContent: true
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

    // 6. Verify requesting user is authorized
    const requestingUser = await db.user.findFirst({
      where: {
        walletAddress: wallet,
        tenantId: tenant.id,
      },
    });

    if (!requestingUser) {
      return res.status(403).json({ error: "User not authorized." });
    }

    const isHost = requestingUser.id === existingAgenda.stream.userId;
    
    // Additional verification: Ensure the host wallet matches
    const isHostWallet = existingAgenda.stream.creatorWallet === wallet;
    const isCoHost = await db.participant.findFirst({
      where: {
        walletAddress: wallet,
        streamId: existingAgenda.stream.id,
        userType: "co-host",
        tenantId: tenant.id,
        leftAt: null
      }
    });

    if (!isHost && !isHostWallet && !isCoHost) {
      return res.status(403).json({ 
        error: "Only hosts and co-hosts can update agendas",
        requiredRole: "host or co-host"
      });
    }

    // 7. Check if update is allowed based on stream status
    const isLive = existingAgenda.stream.isLive;
    
    // Prepare base update data
    const updateData: any = {};
    
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
    } else if (timeStamp !== undefined) {
      return res.status(400).json({ 
        error: "Cannot update timeStamp when stream is live" 
      });
    }

    // 8. Handle content-specific updates with enhanced validation
    let contentUpdate: any = {};
    
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
          try {
            // Get quiz content
            if (!existingAgenda.quizContent) {
              return res.status(404).json({ error: "Quiz content not found" });
            }
            
            // Check if there are already quiz responses
            const hasResponses = await db.quizResponse.findFirst({
              where: {
                question: {
                  quizContent: {
                    agendaId
                  }
                }
              }
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
            
            // Add each new question
            await db.$transaction(async (tx) => {
              for (const question of contentUpdates.questions) {
                await tx.quizQuestion.create({
                  data: {
                    quizContentId: existingAgenda.quizContent!.id,
                    questionText: question.questionText,
                    options: question.options,
                    correctAnswer: question.correctAnswer,
                    isMultiChoice: question.isMultiChoice ?? true,
                    points: question.points ?? 1
                  }
                });
              }
            });
          } catch (error) {
            if (error instanceof Error) {
              return res.status(400).json({ error: error.message });
            }
            throw error;
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
  } catch (error) {
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
 * Controller for deleting a liveStream's agenda
 */
export const deleteAgenda = async (req: TenantRequest, res: Response) => {
  const { agendaId, wallet } = req.params;
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

    // 3. Get agenda with stream and creator info
    const existingAgenda = await db.agenda.findFirst({
      where: {
        id: agendaId,
        tenantId: tenant.id,
      },
      include: {
        stream: {
          include: {
            user: true
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

    // 4. Verify requesting user has permissions
    const requestingUser = await db.user.findFirst({
      where: {
        walletAddress: wallet,
        tenantId: tenant.id,
      },
    });

    if (!requestingUser) {
      return res.status(403).json({ error: "User not authorized." });
    }

    const isHost = requestingUser.id === existingAgenda.stream.user.id;
    const isCoHost = await db.participant.findFirst({
      where: {
        walletAddress: wallet,
        streamId: existingAgenda.stream.id,
        userType: "co-host",
        tenantId: tenant.id,
        leftAt: null
      }
    });

    if (!isHost && !isCoHost) {
      return res.status(403).json({ 
        error: "Only hosts and co-hosts can delete agendas",
        requiredRole: "host or co-host"
      });
    }

    // 5. Delete agenda (cascade will handle all related content)
    await db.agenda.delete({
      where: { id: agendaId },
    });

    res.status(200).json({
      message: "Agenda deleted successfully",
      deletedId: agendaId,
      livestreamId: existingAgenda.stream.name
    });
  } catch (error) {
    console.error("Error deleting agenda:", error);
    
    res.status(500).json({ 
      error: "Internal server error",
    });
  } finally {
    await db.$disconnect();
  }
};

/**
 * Controller for getting a specific agenda by ID
 */
export const getAgenda = async (req: TenantRequest, res: Response) => {
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
        participantResponses: true,
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
  } catch (error) {
    console.error("Error fetching agenda:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    await db.$disconnect();
  }
};

/**
 * Helper function to validate content updates match the agenda type
 */
function getInvalidFieldsForAgendaType(
  actionType: AgendaAction, 
  contentUpdates: any
): string[] {
  const invalidFields: string[] = [];
  
  // Define valid fields for each action type
  const validFields: Record<AgendaAction, string[]> = {
    [AgendaAction.Poll]: ['options'],
    [AgendaAction.Quiz]: ['questions'],
    [AgendaAction.Q_A]: ['topic'],
    [AgendaAction.Custom]: ['customData']
  };
  
  // Check for fields that don't belong to this agenda type
  const contentKeys = Object.keys(contentUpdates).filter(key => 
    key !== 'title' && key !== 'description' && key !== 'timeStamp' && key !== 'wallet' && key !== 'isCompleted'
  );
  
  for (const key of contentKeys) {
    if (!validFields[actionType]?.includes(key)) {
      invalidFields.push(key);
    }
  }
  
  return invalidFields;
}