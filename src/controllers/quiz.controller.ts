import { Response } from "express";
import { db, executeQuery, trackQuery } from "../prisma.js";
import { TenantRequest } from "../types/index.js";
import { isValidWalletAddress } from "../utils/index.js";

// Cache for quiz questions and results
const quizCache = new Map<string, { data: any; timestamp: number }>();
const QUIZ_CACHE_TTL = 60000; // 1 minute


/**
 * Controller for submitting multiple quiz answers - REFACTORED WITHOUT TRANSACTIONS
 */
export const submitQuizAnswers = async (req: TenantRequest, res: Response) => {
  const { agendaId } = req.params;
  const { wallet, answers, totalScore } = req.body;
  const tenant = req.tenant;
  let success = false;

  try {
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    if (!agendaId || !wallet || !answers || !Array.isArray(answers)) {
      return res.status(400).json({ 
        error: "Missing required fields: agendaId, wallet, or answers array" 
      });
    }

    if (typeof totalScore !== 'number' || totalScore < 0) {
      return res.status(400).json({ error: "Invalid totalScore (must be a non-negative number)" });
    }

    if (!isValidWalletAddress(wallet)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    // Get agenda and participant in parallel
    const [agenda, participant] = await Promise.all([
      executeQuery(
        () => db.agenda.findFirst({
          where: {
            id: agendaId,
            tenantId: tenant.id,
            action: "Quiz"
          },
          include: {
            quizContent: {
              include: {
                questions: {
                  select: {
                    id: true
                  }
                }
              }
            },
            stream: {
              select: { id: true }
            }
          }
        }),
        { maxRetries: 2, timeout: 5000 }
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

    if (!agenda) {
      return res.status(404).json({ 
        error: "Quiz not found",
        details: `Agenda ${agendaId} is not found or does not belong to your tenant`
      });
    }

    if (!agenda.quizContent) {
      return res.status(404).json({ 
        error: "Quiz content not found",
        details: `Quiz content for agenda ${agendaId} is missing`
      });
    }

    if (!participant || participant.streamId !== agenda.stream.id) {
      return res.status(404).json({ 
        error: "Participant not found in this stream" 
      });
    }

    // Check if participant has already submitted answers
    const existingResponses = await executeQuery(
      () => db.quizResponse.findFirst({
        where: {
          question: {
            quizContent: {
              agendaId
            }
          },
          participantId: participant.id
        },
        select: { id: true }
      }),
      { maxRetries: 1, timeout: 3000 }
    );

    if (existingResponses) {
      return res.status(400).json({ 
        error: "You have already submitted answers to this quiz" 
      });
    }

    // Validate all questionIds exist in this quiz
    const quizQuestionIds = new Set(agenda.quizContent.questions.map(q => q.id));
    const invalidQuestionIds = answers.filter(a => !quizQuestionIds.has(a.questionId));
    
    if (invalidQuestionIds.length > 0) {
      return res.status(400).json({ 
        error: "Invalid question IDs in submission",
        invalidIds: invalidQuestionIds.map(a => a.questionId)
      });
    }

    // Create responses individually (not in transaction)
    const createdResponses: any[] = [];
    const failedResponses: any[] = [];

    // Step 1: Create all quiz responses
    for (const answer of answers) {
      try {
        const response = await executeQuery(
          () => db.quizResponse.create({
            data: {
              questionId: answer.questionId,
              participantId: participant.id,
              answer: answer.answer,
              isCorrect: answer.isCorrect,
              pointsEarned: answer.pointsEarned || 0
            }
          }),
          { maxRetries: 1, timeout: 3000 }
        );
        createdResponses.push(response);
      } catch (error: any) {
        // If it's a unique constraint violation, the user already answered
        if (error.code === 'P2002') {
          failedResponses.push({
            questionId: answer.questionId,
            error: "Already answered"
          });
        } else {
          failedResponses.push({
            questionId: answer.questionId,
            error: error.message
          });
        }
      }
    }

    // Step 2: Create participant response record (if at least one answer was saved)
    if (createdResponses.length > 0) {
      await executeQuery(
        () => db.participantResponse.create({
          data: {
            agendaId: agenda.id,
            participantId: participant.id,
            responseType: "quiz_submission"
          }
        }),
        { maxRetries: 1, timeout: 3000 }
      ).catch(err => {
        console.error("Failed to create participant response record:", err);
        // Non-critical - continue
      });

      // Step 3: Update participant points
      await executeQuery(
        () => db.participant.update({
          where: { id: participant.id },
          data: { 
            totalPoints: { increment: totalScore },
            version: { increment: 1 }
          }
        }),
        { maxRetries: 2, timeout: 3000 }
      ).catch(err => {
        console.error("Failed to update participant points:", err);
        // Non-critical - points can be recalculated
      });
    }

    // Invalidate cache
    quizCache.delete(`${agendaId}:results`);

    // Return appropriate response
    if (createdResponses.length === 0) {
      return res.status(400).json({
        error: "Failed to submit any answers",
        failures: failedResponses
      });
    }

    if (failedResponses.length > 0) {
      // Partial success
      success = true;
      return res.status(207).json({
        message: "Quiz answers partially submitted",
        submitted: createdResponses.length,
        failed: failedResponses.length,
        totalScore: totalScore * (createdResponses.length / answers.length),
        failures: failedResponses
      });
    }

    // Complete success
    success = true;
    res.status(201).json({
      message: "Quiz answers submitted successfully",
      totalScore,
      answersSubmitted: createdResponses.length
    });
  } catch (error: any) {
    console.error("Error submitting quiz answers:", error);
    
    if (error.code === 'P2028' || error.code === 'TIMEOUT') {
      return res.status(408).json({ 
        error: "Request timeout - please try again",
        details: "The operation took too long to complete"
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
 * Controller for getting quiz questions - OPTIMIZED
 */
export const getQuizQuestions = async (req: TenantRequest, res: Response) => {
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
    const cacheKey = `${agendaId}:questions`;
    const cached = quizCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < QUIZ_CACHE_TTL) {
      success = true;
      return res.status(200).json(cached.data);
    }

    // 4. Get quiz from database
    const agenda = await executeQuery(
      () => db.agenda.findFirst({
        where: {
          id: agendaId,
          tenantId: tenant.id,
          action: "Quiz"
        },
        include: {
          quizContent: {
            include: {
              questions: {
                select: {
                  id: true,
                  questionText: true,
                  options: true,
                  isMultiChoice: true,
                  points: true,
                  correctAnswer: true,
                }
              }
            }
          }
        }
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    if (!agenda || !agenda.quizContent) {
      return res.status(404).json({ 
        error: "Quiz not found",
        details: `Agenda ${agendaId} is not a quiz or does not exist`
      });
    }

    // 5. Format the response
    const result = {
      id: agenda.id,
      title: agenda.title,
      description: agenda.description,
      duration: agenda.duration,
      questions: agenda.quizContent.questions
    };

    // Cache the result
    quizCache.set(cacheKey, { data: result, timestamp: Date.now() });

    success = true;
    return res.status(200).json(result);
  } catch (error) {
    console.error("Error fetching quiz questions:", error);
    return res.status(500).json({ 
      error: "Internal server error",
    });
  } finally {
    trackQuery(success);
  }
};

/**
 * Controller for getting quiz results - OPTIMIZED
 */
export const getQuizResults = async (req: TenantRequest, res: Response) => {
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
    const cacheKey = `${agendaId}:results`;
    const cached = quizCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < QUIZ_CACHE_TTL) {
      success = true;
      return res.status(200).json(cached.data);
    }

    // 4. Get quiz agenda
    const agenda = await executeQuery(
      () => db.agenda.findFirst({
        where: {
          id: agendaId,
          tenantId: tenant.id,
          action: "Quiz"
        },
        include: {
          quizContent: {
            include: {
              questions: {
                select: {
                  id: true,
                  questionText: true
                }
              }
            }
          },
          stream: {
            select: { id: true }
          }
        }
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    if (!agenda || !agenda.quizContent) {
      return res.status(404).json({ 
        error: "Quiz not found",
        details: `Agenda ${agendaId} is not a quiz or does not exist`
      });
    }

    // 5. Get participants and statistics in parallel
    const [participants, allParticipantsCount, questionStats] = await Promise.all([
      executeQuery(
        () => db.participant.findMany({
          where: {
            streamId: agenda.stream.id,
            quizResponses: {
              some: {
                question: {
                  quizContent: {
                    agendaId
                  }
                }
              }
            }
          },
          include: {
            quizResponses: {
              where: {
                question: {
                  quizContent: {
                    agendaId
                  }
                }
              },
              select: {
                isCorrect: true,
                pointsEarned: true
              }
            }
          },
          orderBy: {
            totalPoints: 'desc'
          }
        }),
        { maxRetries: 2, timeout: 10000 }
      ),
      executeQuery(
        () => db.participant.count({
          where: {
            streamId: agenda.stream.id,
            leftAt: null
          }
        }),
        { maxRetries: 1, timeout: 5000 }
      ),
      Promise.all(agenda.quizContent.questions.map(async (question) => {
        const responses = await executeQuery(
          () => db.quizResponse.findMany({
            where: {
              questionId: question.id
            },
            select: {
              isCorrect: true
            }
          }),
          { maxRetries: 1, timeout: 5000 }
        );
        
        const totalResponses = responses.length;
        const correctResponses = responses.filter(r => r.isCorrect).length;
        
        return {
          id: question.id,
          questionText: question.questionText,
          totalResponses,
          correctResponses,
          correctPercentage: totalResponses > 0 ? Math.round((correctResponses / totalResponses) * 100) : 0
        };
      }))
    ]);

    // 7. Format the leaderboard
    const leaderboard = participants.map(participant => {
      const correctAnswers = participant.quizResponses.filter(r => r.isCorrect).length;
      const totalAnswers = participant.quizResponses.length;
      const pointsFromQuiz = participant.quizResponses.reduce((sum, r) => sum + r.pointsEarned, 0);
      
      return {
        participantId: participant.id,
        userName: participant.userName,
        walletAddress: participant.walletAddress,
        pointsEarned: pointsFromQuiz,
        totalPoints: participant.totalPoints,
        correctAnswers,
        totalAnswers,
        accuracy: totalAnswers > 0 ? Math.round((correctAnswers / totalAnswers) * 100) : 0
      };
    });

    const result = {
      id: agenda.id,
      title: agenda.title,
      totalParticipants: allParticipantsCount,
      participantsAnswered: participants.length,
      questionStats,
      leaderboard
    };

    // Cache the result
    quizCache.set(cacheKey, { data: result, timestamp: Date.now() });

    success = true;
    return res.status(200).json(result);
  } catch (error) {
    console.error("Error fetching quiz results:", error);
    return res.status(500).json({ 
      error: "Internal server error",
    });
  } finally {
    trackQuery(success);
  }
};

/**
 * Controller for getting a participant's quiz answers - OPTIMIZED
 */
export const getUserQuizAnswers = async (req: TenantRequest, res: Response) => {
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
      executeQuery(
        () => db.agenda.findFirst({
          where: {
            id: agendaId,
            tenantId: tenant.id,
            action: "Quiz"
          },
          include: {
            quizContent: {
              include: {
                questions: {
                  select: {
                    id: true,
                    questionText: true,
                    correctAnswer: true
                  }
                }
              }
            },
            stream: {
              select: { id: true }
            }
          }
        }),
        { maxRetries: 2, timeout: 10000 }
      ),
      executeQuery(
        () => db.participant.findFirst({
          where: {
            walletAddress: wallet,
            tenantId: tenant.id
          },
          select: {
            id: true,
            userName: true,
            walletAddress: true,
            streamId: true
          }
        }),
        { maxRetries: 1, timeout: 5000 }
      )
    ]);

    if (!agenda || !agenda.quizContent) {
      return res.status(404).json({ 
        error: "Quiz not found",
        details: `Agenda ${agendaId} is not a quiz or does not exist`
      });
    }

    if (!participant || participant.streamId !== agenda.stream.id) {
      return res.status(404).json({ 
        error: "Participant not found in this stream" 
      });
    }

    // 5. Get participant's answers
    const responses = await executeQuery(
      () => db.quizResponse.findMany({
        where: {
          participantId: participant.id,
          question: {
            quizContent: {
              agendaId
            }
          }
        },
        select: {
          questionId: true,
          answer: true,
          isCorrect: true,
          pointsEarned: true
        }
      }),
      { maxRetries: 2, timeout: 10000 }
    );

    // 6. Format the response
    const responseMap = new Map(responses.map(r => [r.questionId, r]));
    
    const questionResponses = agenda.quizContent.questions.map(question => {
      const response = responseMap.get(question.id);
      
      return {
        questionId: question.id,
        questionText: question.questionText,
        answered: !!response,
        answer: response?.answer || null,
        isCorrect: response?.isCorrect || false,
        pointsEarned: response?.pointsEarned || 0,
        correctAnswer: question.correctAnswer
      };
    });

    // 7. Calculate totals
    const totalPoints = responses.reduce((sum, r) => sum + r.pointsEarned, 0);
    const correctAnswers = responses.filter(r => r.isCorrect).length;

    success = true;
    return res.status(200).json({
      participantId: participant.id,
      userName: participant.userName,
      walletAddress: participant.walletAddress,
      totalPoints,
      answeredQuestions: responses.length,
      correctAnswers,
      totalQuestions: agenda.quizContent.questions.length,
      responses: questionResponses
    });
  } catch (error) {
    console.error("Error fetching user quiz answers:", error);
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
  for (const [key, value] of quizCache.entries()) {
    if (now - value.timestamp > QUIZ_CACHE_TTL) {
      quizCache.delete(key);
    }
  }
}, 60000); // Clean every minute