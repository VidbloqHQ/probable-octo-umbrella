import { Response } from "express";
import { AgendaAction } from "@prisma/client";
import { db, executeQuery, trackQuery } from "../prisma.js";
import { TenantRequest } from "../types/index.js";
import { isValidWalletAddress } from "../utils/index.js";

// Cache for stream and user authorization data
const authCache = new Map<string, { data: any; timestamp: number }>();
const AUTH_CACHE_TTL = 30000; // 30 seconds

// Cache for agenda data
const agendaCache = new Map<string, { data: any; timestamp: number }>();
const AGENDA_CACHE_TTL = 30000; // 30 seconds

/**
 * Helper to get cached or fetch authorization data
 */
async function getAuthorizationData(
  streamId: string,
  wallet: string,
  tenantId: string
) {
  const cacheKey = `${streamId}:${wallet}:${tenantId}`;
  const cached = authCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < AUTH_CACHE_TTL) {
    return cached.data;
  }
  
  // Parallel fetch stream and user data
  const [stream, requestingUser] = await Promise.all([
    executeQuery(
      () => db.stream.findFirst({
        where: {
          name: streamId,
          tenantId,
        },
        select: {
          id: true,
          userId: true,
          creatorWallet: true,
          isLive: true,
        }
      }),
      { maxRetries: 1, timeout: 2000 }
    ),
    executeQuery(
      () => db.user.findFirst({
        where: {
          walletAddress: wallet,
          tenantId,
        },
        select: { id: true }
      }),
      { maxRetries: 1, timeout: 2000 }
    )
  ]);
  
  const data = { stream, requestingUser };
  authCache.set(cacheKey, { data, timestamp: Date.now() });
  
  return data;
}

/**
 * OPTIMIZED: Get stream agendas with pagination and caching
 */
export const getStreamAgenda = async (
  req: TenantRequest,
  res: Response
) => {
  const { streamId } = req.params;
  const tenant = req.tenant;
  let success = false;
  console.log('[NEW-AGENDA] getStreamAgenda called at', Date.now());

  // Add pagination parameters
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
  const skip = (page - 1) * limit;

  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!streamId) {
      return res.status(400).json({ error: "Missing livestream ID" });
    }

    // Check cache first
    const cacheKey = `${tenant.id}:${streamId}:agendas:${page}:${limit}`;
    const cached = agendaCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < AGENDA_CACHE_TTL) {
      success = true;
      return res.status(200).json(cached.data);
    }

    // OPTIMIZED: Single query to get stream and agendas
    const streamWithAgendas = await executeQuery(
      () => db.stream.findFirst({
        where: {
          name: streamId,
          tenantId: tenant.id,
        },
        select: {
          id: true,
          name: true,
          _count: {
            select: { agenda: true }
          },
          agenda: {
            select: {
              id: true,
              timeStamp: true,
              action: true,
              title: true,
              description: true,
              duration: true,
              isCompleted: true,
              // Only include IDs for content types, not full content
              pollContent: {
                select: { id: true }
              },
              quizContent: {
                select: { id: true }
              },
              qaContent: {
                select: { id: true }
              },
              customContent: {
                select: { id: true }
              },
            },
            orderBy: {
              timeStamp: 'asc'
            },
            skip: skip,
            take: limit
          }
        }
      }),
      { maxRetries: 1, timeout: 2500 }
    );

    if (!streamWithAgendas) {
      return res.status(404).json({ error: "Stream not found in your tenant" });
    }

    const result = {
      agendas: streamWithAgendas.agenda.map(agenda => ({
        ...agenda,
        hasContent: !!(agenda.pollContent || agenda.quizContent || agenda.qaContent || agenda.customContent)
      })),
      pagination: {
        page,
        limit,
        total: streamWithAgendas._count.agenda,
        totalPages: Math.ceil(streamWithAgendas._count.agenda / limit)
      }
    };

    // Cache the result
    agendaCache.set(cacheKey, { data: result, timestamp: Date.now() });

    success = true;
    return res.status(200).json(result);
    
  } catch (error: any) {
    console.error("Error fetching agendas:", error);
    
    if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
      return res.status(504).json({ 
        error: "Database query timeout",
        message: "The request took too long. Please try again."
      });
    }
    
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

/**
 * OPTIMIZED: Get single agenda details with selective loading
 */
export const getAgendaDetails = async (req: TenantRequest, res: Response) => {
  const { agendaId } = req.params;
  const tenant = req.tenant;
  let success = false;
  console.log('[NEW-AGENDA] getAgendaDetails called at', Date.now());

  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!agendaId) {
      return res.status(400).json({ error: "Missing agenda ID" });
    }

    // Check cache first
    const cacheKey = `${tenant.id}:agenda:${agendaId}`;
    const cached = agendaCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < AGENDA_CACHE_TTL) {
      success = true;
      return res.status(200).json(cached.data);
    }

    // OPTIMIZED: Use selective field loading
    const agenda = await executeQuery(
      () => db.agenda.findFirst({
        where: {
          id: agendaId,
          tenantId: tenant.id,
        },
        select: {
          id: true,
          streamId: true,
          timeStamp: true,
          action: true,
          title: true,
          description: true,
          duration: true,
          isCompleted: true,
          
          // Conditional loading based on action type
          pollContent: true,
          quizContent: {
            select: {
              id: true,
              questions: {
                select: {
                  id: true,
                  questionText: true,
                  options: true,
                  points: true,
                  isMultiChoice: true
                },
                take: 10
              }
            }
          },
          qaContent: true,
          customContent: true,
          
          // Just count responses
          _count: {
            select: {
              participantResponses: true
            }
          }
        }
      }),
      { maxRetries: 1, timeout: 2000 }
    );

    if (!agenda) {
      return res.status(404).json({ 
        error: "Agenda not found",
        details: `Agenda ${agendaId} not found in your tenant`
      });
    }

    const result = {
      ...agenda,
      responseCount: agenda._count?.participantResponses || 0,
      _count: undefined
    };

    // Cache the result
    agendaCache.set(cacheKey, { data: result, timestamp: Date.now() });

    success = true;
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("Error fetching agenda details:", error);
    
    if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
      return res.status(504).json({ 
        error: "Database query timeout",
        message: "The request took too long. Please try again."
      });
    }
    
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

/**
 * OPTIMIZED: Create agenda with batch processing
 */
export const createAgenda = async (req: TenantRequest, res: Response) => {
  const { streamId } = req.params;
  const { agendas, wallet } = req.body;
  const tenant = req.tenant;
  let success = false;
  console.log('[NEW-AGENDA] createAgenda called at', Date.now());

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

    // Get authorization data with cache
    const authData = await getAuthorizationData(streamId, wallet, tenant.id);
    const { stream, requestingUser } = authData;

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
    if (!isHost) {
      // Check if co-host (simplified query)
      const isCoHost = await executeQuery(
        () => db.participant.findFirst({
          where: {
            streamId: stream.id,
            walletAddress: wallet,
            userType: "co-host",
            leftAt: null
          },
          select: { id: true }
        }),
        { maxRetries: 1, timeout: 1500 }
      );

      if (!isCoHost) {
        return res.status(403).json({ 
          error: "Only hosts and co-hosts can create agendas"
        });
      }
    }

    // OPTIMIZED: Create all agendas in a single transaction
    const agendasToCreate = agendas.slice(0, 10); // Limit to 10
    
    const createdAgendas = await executeQuery(
      () => db.$transaction(
        agendasToCreate.map((agenda: any) => 
          db.agenda.create({
            data: {
              streamId: stream.id,
              timeStamp: agenda.timeStamp,
              action: agenda.action as AgendaAction,
              title: agenda.title || null,
              description: agenda.description || null,
              duration: agenda.duration || null,
              tenantId: tenant.id,
              
              // Create related content based on type
              ...(agenda.action === AgendaAction.Poll && agenda.options && {
                pollContent: {
                  create: {
                    options: agenda.options,
                    totalVotes: 0
                  }
                }
              }),
              
              ...(agenda.action === AgendaAction.Quiz && agenda.questions && {
                quizContent: {
                  create: {
                    questions: {
                      create: agenda.questions.slice(0, 10).map((q: any) => ({
                        questionText: q.questionText,
                        options: q.options || [],
                        correctAnswer: q.correctAnswer,
                        isMultiChoice: q.isMultiChoice ?? true,
                        points: q.points ?? 1
                      }))
                    }
                  }
                }
              }),
              
              ...(agenda.action === AgendaAction.Q_A && {
                qaContent: {
                  create: {
                    topic: agenda.topic || agenda.title || null
                  }
                }
              }),
              
              ...(agenda.action === AgendaAction.Custom && {
                customContent: {
                  create: {
                    customData: agenda.customData || {}
                  }
                }
              })
            },
            select: {
              id: true,
              timeStamp: true,
              action: true,
              title: true,
              description: true
            }
          })
        )
      ),
      { maxRetries: 2, timeout: 5000 }
    );

    // Invalidate cache
    agendaCache.clear();

    success = true;
    return res.status(201).json(createdAgendas);

  } catch (error: any) {
    console.error("Error creating agenda:", error);
    
    if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
      return res.status(504).json({ 
        error: "Request timeout",
        message: "The operation took too long. Please try again."
      });
    }
    
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

/**
 * Get agenda by ID (simplified version)
 */
export const getAgendaById = async (req: TenantRequest, res: Response) => {
  const { agendaId } = req.params;
  const tenant = req.tenant;
  let success = false;
  
  try {
    if (!tenant || !agendaId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check cache first
    const cacheKey = `${tenant.id}:agenda:${agendaId}:simple`;
    const cached = agendaCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < AGENDA_CACHE_TTL) {
      success = true;
      return res.status(200).json(cached.data);
    }

    const agenda = await executeQuery(
      () => db.agenda.findFirst({
        where: {
          id: agendaId,
          tenantId: tenant.id,
        },
        select: {
          id: true,
          streamId: true,
          timeStamp: true,
          action: true,
          title: true,
          description: true,
          duration: true,
          isCompleted: true
        }
      }),
      { maxRetries: 1, timeout: 1500 }
    );

    if (!agenda) {
      return res.status(404).json({ error: "Agenda not found" });
    }

    // Cache the result
    agendaCache.set(cacheKey, { data: agenda, timestamp: Date.now() });

    success = true;
    return res.status(200).json(agenda);
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    trackQuery(success);
  }
};

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  
  // Clean auth cache
  for (const [key, value] of authCache.entries()) {
    if (now - value.timestamp > AUTH_CACHE_TTL) {
      authCache.delete(key);
    }
  }
  
  // Clean agenda cache
  for (const [key, value] of agendaCache.entries()) {
    if (now - value.timestamp > AGENDA_CACHE_TTL) {
      agendaCache.delete(key);
    }
  }
}, 60000); // Clean every minute

// Export other functions
// export { updateStreamAgenda, deleteAgenda, getAgenda } from "../controllers/agenda.controller.js";