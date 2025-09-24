import { Response } from "express";
import { db, executeQuery, trackQuery } from "../prisma.js";
import { TenantRequest } from "../types/index.js";

// Cache for Q&A content
const qaCache = new Map<string, { data: any; timestamp: number }>();
const QA_CACHE_TTL = 60000; // 1 minute

/**
 * Controller for getting Q&A content - OPTIMIZED
 */
export const getQAContent = async (req: TenantRequest, res: Response) => {
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
    const cacheKey = `${tenant.id}:qa:${agendaId}:content`;
    const cached = qaCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < QA_CACHE_TTL) {
      success = true;
      return res.status(200).json(cached.data);
    }

    // 4. Get Q&A from database
    const agenda = await executeQuery(
      () => db.agenda.findFirst({
        where: {
          id: agendaId,
          tenantId: tenant.id,
          action: "Q_A"
        },
        select: {
          id: true,
          title: true,
          description: true,
          duration: true,
          isCompleted: true,
          qaContent: {
            select: {
              id: true,
              topic: true
            }
          },
          _count: {
            select: {
              participantResponses: true
            }
          }
        }
      }),
      { maxRetries: 1, timeout: 1500 }
    );

    if (!agenda || !agenda.qaContent) {
      return res.status(404).json({ 
        error: "Q&A session not found",
        details: `Agenda ${agendaId} is not a Q&A session or does not exist`
      });
    }

    // 5. Format the response
    const result = {
      id: agenda.id,
      title: agenda.title,
      description: agenda.description,
      duration: agenda.duration,
      isCompleted: agenda.isCompleted,
      qaContent: {
        id: agenda.qaContent.id,
        topic: agenda.qaContent.topic
      },
      responseCount: agenda._count?.participantResponses || 0
    };

    // Cache the result
    qaCache.set(cacheKey, { data: result, timestamp: Date.now() });

    success = true;
    return res.status(200).json(result);
  } catch (error: any) {
    console.error("Error fetching Q&A content:", error);
    
    if (error.message === 'Query timeout' || error.code === 'TIMEOUT') {
      return res.status(504).json({ 
        error: "Database query timeout",
        message: "The request took too long. Please try again."
      });
    }
    
    return res.status(500).json({ 
      error: "Internal server error",
    });
  } finally {
    trackQuery(success);
  }
};

/**
 * Controller for submitting a Q&A question/response
 */
export const submitQAResponse = async (req: TenantRequest, res: Response) => {
  const { agendaId } = req.params;
  const { wallet, question, responseType = "question" } = req.body;
  const tenant = req.tenant;
  let success = false;

  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!agendaId || !wallet || !question) {
      return res.status(400).json({ 
        error: "Missing required fields: agendaId, wallet, or question" 
      });
    }

    // Get agenda and participant in parallel
    const [agenda, participant] = await Promise.all([
      executeQuery(
        () => db.agenda.findFirst({
          where: {
            id: agendaId,
            tenantId: tenant.id,
            action: "Q_A"
          },
          include: {
            qaContent: true,
            stream: {
              select: { id: true }
            }
          }
        }),
        { maxRetries: 1, timeout: 3000 }
      ),
      executeQuery(
        () => db.participant.findFirst({
          where: {
            walletAddress: wallet,
            tenantId: tenant.id
          },
          select: {
            id: true,
            streamId: true
          }
        }),
        { maxRetries: 1, timeout: 3000 }
      )
    ]);

    if (!agenda || !agenda.qaContent) {
      return res.status(404).json({ 
        error: "Q&A session not found",
        details: `Agenda ${agendaId} is not a Q&A session or does not exist`
      });
    }

    if (!participant || participant.streamId !== agenda.stream.id) {
      return res.status(403).json({ 
        error: "Only active stream participants can submit questions" 
      });
    }

    // Create participant response record
    await executeQuery(
      () => db.participantResponse.create({
        data: {
          agendaId: agenda.id,
          participantId: participant.id,
          responseType: responseType // "question" or "answer"
        }
      }),
      { maxRetries: 1, timeout: 3000 }
    );

    // Invalidate cache
    qaCache.delete(`${tenant.id}:qa:${agendaId}:content`);

    success = true;
    return res.status(201).json({
      message: "Q&A response submitted successfully",
      agendaId,
      title: agenda.title
    });

  } catch (error: any) {
    console.error("Error submitting Q&A response:", error);
    return res.status(500).json({ 
      error: "Internal server error",
    });
  } finally {
    trackQuery(success);
  }
};

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of qaCache.entries()) {
    if (now - value.timestamp > QA_CACHE_TTL) {
      qaCache.delete(key);
    }
  }
}, 60000);