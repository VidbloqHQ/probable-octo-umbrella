import { Response } from "express";
import { db } from "../prisma.js";
import { TenantRequest } from "../types/index.js";
import { isValidWalletAddress } from "../utils/index.js";

/**
 * Controller for submitting multiple quiz answers at once
 */
// export const submitQuizAnswers = async (req: TenantRequest, res: Response) => {
//   const { agendaId } = req.params;
//   const { wallet, answers, totalScore } = req.body;
//   const tenant = req.tenant;

//   try {
//     // 1. Tenant verification
//     if (!tenant) {
//       return res.status(401).json({ error: "Tenant authentication required." });
//     }

//     // 2. Input validation
//     if (!agendaId || !wallet || !answers || !Array.isArray(answers)) {
//       return res.status(400).json({ 
//         error: "Missing required fields: agendaId, wallet, or answers array" 
//       });
//     }

//     if (typeof totalScore !== 'number' || totalScore < 0) {
//       return res.status(400).json({ error: "Invalid totalScore (must be a non-negative number)" });
//     }

//     if (!isValidWalletAddress(wallet)) {
//       return res.status(400).json({ error: "Invalid wallet address format." });
//     }

//     // 3. Verify agenda belongs to tenant and is a quiz
//     const agenda = await db.agenda.findFirst({
//       where: {
//         id: agendaId,
//         tenantId: tenant.id,
//         action: "Quiz"
//       },
//       include: {
//         quizContent: {
//           include: {
//             questions: true
//           }
//         },
//         stream: true
//       }
//     });

//     if (!agenda) {
//       return res.status(404).json({ 
//         error: "Quiz not found",
//         details: `Agenda ${agendaId} is not found or does not belong to your tenant`
//       });
//     }

//     if (!agenda.quizContent) {
//       return res.status(404).json({ 
//         error: "Quiz content not found",
//         details: `Quiz content for agenda ${agendaId} is missing`
//       });
//     }

//     // 4. Verify participant
//     const participant = await db.participant.findFirst({
//       where: {
//         walletAddress: wallet,
//         streamId: agenda.stream.id,
//         tenantId: tenant.id
//       }
//     });

//     if (!participant) {
//       return res.status(404).json({ 
//         error: "Participant not found" 
//       });
//     }

//     // 5. Check if participant has already submitted answers to this quiz
//     const existingResponses = await db.quizResponse.findFirst({
//       where: {
//         question: {
//           quizContent: {
//             agendaId
//           }
//         },
//         participantId: participant.id
//       }
//     });

//     if (existingResponses) {
//       return res.status(400).json({ 
//         error: "You have already submitted answers to this quiz" 
//       });
//     }

//     // 6. Validate all questionIds exist in this quiz
//     const quizQuestionIds = agenda.quizContent.questions.map(q => q.id);
//     const invalidQuestionIds = answers.filter(a => !quizQuestionIds.includes(a.questionId));
    
//     if (invalidQuestionIds.length > 0) {
//       return res.status(400).json({ 
//         error: "Invalid question IDs in submission",
//         invalidIds: invalidQuestionIds.map(a => a.questionId)
//       });
//     }

//     // 7. Create responses for each answer using a transaction
//     await db.$transaction(async (tx) => {
//       // Create each response
//       for (const answer of answers) {
//         // Using the non-null assertion operator (!) since we've already checked above
//         const question = agenda.quizContent!.questions.find(q => q.id === answer.questionId);
//         if (!question) continue; // Skip if question not found (should never happen due to validation above)
        
//         // Create the response
//         await tx.quizResponse.create({
//           data: {
//             questionId: answer.questionId,
//             participantId: participant.id,
//             answer: answer.answer,
//             isCorrect: answer.isCorrect,
//             pointsEarned: answer.pointsEarned || 0
//           }
//         });
//       }
      
//       // Create a participant response record
//       await tx.participantResponse.create({
//         data: {
//           agendaId: agenda.id,
//           participantId: participant.id,
//           responseType: "quiz_submission"
//         }
//       });
      
//       // Update participant's total points
//       await tx.participant.update({
//         where: { id: participant.id },
//         data: { 
//           totalPoints: { increment: totalScore }
//         }
//       });
//     });

//     res.status(201).json({
//       message: "Quiz answers submitted successfully",
//       totalScore,
//       answersSubmitted: answers.length
//     });
//   } catch (error) {
//     console.error("Error submitting quiz answers:", error);
//     res.status(500).json({ 
//       error: "Internal server error",
//     });
//   } 
//   // finally {
//   //   await db.$disconnect();
//   // }
// };

export const submitQuizAnswers = async (req: TenantRequest, res: Response) => {
  const { agendaId } = req.params;
  const { wallet, answers, totalScore } = req.body;
  const tenant = req.tenant;

  try {
    // 1. Tenant verification
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required." });
    }

    // 2. Input validation
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

    // 3. Verify agenda belongs to tenant and is a quiz
    const agenda = await db.agenda.findFirst({
      where: {
        id: agendaId,
        tenantId: tenant.id,
        action: "Quiz"
      },
      include: {
        quizContent: {
          include: {
            questions: true
          }
        },
        stream: true
      }
    });

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

    // 4. Verify participant
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

    // 5. Check if participant has already submitted answers to this quiz
    const existingResponses = await db.quizResponse.findFirst({
      where: {
        question: {
          quizContent: {
            agendaId
          }
        },
        participantId: participant.id
      }
    });

    if (existingResponses) {
      return res.status(400).json({ 
        error: "You have already submitted answers to this quiz" 
      });
    }

    // 6. Validate all questionIds exist in this quiz
    const quizQuestionIds = agenda.quizContent.questions.map(q => q.id);
    const invalidQuestionIds = answers.filter(a => !quizQuestionIds.includes(a.questionId));
    
    if (invalidQuestionIds.length > 0) {
      return res.status(400).json({ 
        error: "Invalid question IDs in submission",
        invalidIds: invalidQuestionIds.map(a => a.questionId)
      });
    }

    // 7. Prepare data for bulk operations
    const quizResponseData = answers.map(answer => ({
      questionId: answer.questionId,
      participantId: participant.id,
      answer: answer.answer,
      isCorrect: answer.isCorrect,
      pointsEarned: answer.pointsEarned || 0
    }));

    // 8. Create responses without transaction
    console.log('Creating quiz responses...');
    await db.quizResponse.createMany({
      data: quizResponseData
    });
    
    console.log('Creating participant response...');
    await db.participantResponse.create({
      data: {
        agendaId: agenda.id,
        participantId: participant.id,
        responseType: "quiz_submission"
      }
    });
    
    console.log('Updating participant points...');
    await db.participant.update({
      where: { id: participant.id },
      data: { 
        totalPoints: { increment: totalScore }
      }
    });

    console.log('Quiz submission completed successfully');
    res.status(201).json({
      message: "Quiz answers submitted successfully",
      totalScore,
      answersSubmitted: answers.length
    });
  } catch (error) {
    console.error("Error submitting quiz answers:", error);
    
    // More specific error handling
    if (typeof error === "object" && error !== null && "code" in error) {
      if ((error as { code: string }).code === 'P2028') {
        return res.status(408).json({ 
          error: "Request timeout - please try again",
          details: "The operation took too long to complete"
        });
      }
      
      if ((error as { code: string }).code === 'P2002') {
        return res.status(400).json({ 
          error: "Duplicate submission detected",
          details: "This quiz has already been submitted"
        });
      }
    }
    
    res.status(500).json({ 
      error: "Internal server error",
    });
  }
};

/**
 * Controller for getting quiz questions (including correct answers for hosts)
 */
export const getQuizQuestions = async (req: TenantRequest, res: Response) => {
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

    // 3. Verify agenda belongs to tenant and is a quiz
    const agenda = await db.agenda.findFirst({
      where: {
        id: agendaId,
        tenantId: tenant.id,
        action: "Quiz"
      },
      include: {
        quizContent: {
          include: {
            questions: true
          }
        }
      }
    });

    if (!agenda || !agenda.quizContent) {
      return res.status(404).json({ 
        error: "Quiz not found",
        details: `Agenda ${agendaId} is not a quiz or does not exist`
      });
    }

    // 4. Format the response (hiding correct answers)
    const questions = agenda.quizContent.questions.map(q => ({
      id: q.id,
      questionText: q.questionText,
      options: q.options,
      isMultiChoice: q.isMultiChoice,
      points: q.points,
      correctAnswer: q.correctAnswer,
    }));

    res.status(200).json({
      id: agenda.id,
      title: agenda.title,
      description: agenda.description,
      duration: agenda.duration,
      questions
    });
  } catch (error) {
    console.error("Error fetching quiz questions:", error);
    res.status(500).json({ 
      error: "Internal server error",
    });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * Controller for getting quiz results
 */
export const getQuizResults = async (req: TenantRequest, res: Response) => {
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

    // 3. Verify agenda belongs to tenant and is a quiz
    const agenda = await db.agenda.findFirst({
      where: {
        id: agendaId,
        tenantId: tenant.id,
        action: "Quiz"
      },
      include: {
        quizContent: {
          include: {
            questions: true
          }
        },
        stream: true
      }
    });

    if (!agenda || !agenda.quizContent) {
      return res.status(404).json({ 
        error: "Quiz not found",
        details: `Agenda ${agendaId} is not a quiz or does not exist`
      });
    }

    // 4. Get participants with quiz responses
    const participants = await db.participant.findMany({
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
          }
        }
      },
      orderBy: {
        totalPoints: 'desc'
      }
    });

    // 5. Get all active participants in this stream
    const allParticipants = await db.participant.count({
      where: {
        streamId: agenda.stream.id,
        leftAt: null
      }
    });

    // 6. Calculate statistics for each question
    const questionStats = await Promise.all(agenda.quizContent.questions.map(async (question) => {
      const responses = await db.quizResponse.findMany({
        where: {
          questionId: question.id
        }
      });
      
      const totalResponses = responses.length;
      const correctResponses = responses.filter(r => r.isCorrect).length;
      
      return {
        id: question.id,
        questionText: question.questionText,
        totalResponses,
        correctResponses,
        correctPercentage: totalResponses > 0 ? Math.round((correctResponses / totalResponses) * 100) : 0
      };
    }));

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

    res.status(200).json({
      id: agenda.id,
      title: agenda.title,
      totalParticipants: allParticipants,
      participantsAnswered: participants.length,
      questionStats,
      leaderboard
    });
  } catch (error) {
    console.error("Error fetching quiz results:", error);
    res.status(500).json({ 
      error: "Internal server error",
    });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};

/**
 * Controller for getting a participant's quiz answers
 */
export const getUserQuizAnswers = async (req: TenantRequest, res: Response) => {
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

    if (!isValidWalletAddress(wallet as string)) {
      return res.status(400).json({ error: "Invalid wallet address format." });
    }

    // 3. Verify agenda belongs to tenant and is a quiz
    const agenda = await db.agenda.findFirst({
      where: {
        id: agendaId,
        tenantId: tenant.id,
        action: "Quiz"
      },
      include: {
        quizContent: {
          include: {
            questions: true
          }
        },
        stream: true
      }
    });

    if (!agenda || !agenda.quizContent) {
      return res.status(404).json({ 
        error: "Quiz not found",
        details: `Agenda ${agendaId} is not a quiz or does not exist`
      });
    }

    // 4. Find participant
    const participant = await db.participant.findFirst({
      where: {
        walletAddress: wallet as string,
        streamId: agenda.stream.id,
        tenantId: tenant.id
      }
    });

    if (!participant) {
      return res.status(404).json({ 
        error: "Participant not found" 
      });
    }

    // 5. Find participant's answers
    const responses = await db.quizResponse.findMany({
      where: {
        participantId: participant.id,
        question: {
          quizContent: {
            agendaId
          }
        }
      },
      include: {
        question: true
      }
    });

    // 6. Format the response
    const questionResponses = [];
    
    for (const question of agenda.quizContent.questions) {
      const response = responses.find(r => r.questionId === question.id);
      
      questionResponses.push({
        questionId: question.id,
        questionText: question.questionText,
        answered: !!response,
        answer: response?.answer || null,
        isCorrect: response?.isCorrect || false,
        pointsEarned: response?.pointsEarned || 0,
        correctAnswer: question.correctAnswer // Include correct answer so client can show it
      });
    }

    // 7. Calculate totals
    const totalPoints = responses.reduce((sum, r) => sum + r.pointsEarned, 0);
    const correctAnswers = responses.filter(r => r.isCorrect).length;

    res.status(200).json({
      participantId: participant.id,
      userName: participant.userName,
      walletAddress: participant.walletAddress,
      totalPoints: totalPoints,
      answeredQuestions: responses.length,
      correctAnswers,
      totalQuestions: agenda.quizContent.questions.length,
      responses: questionResponses
    });
  } catch (error) {
    console.error("Error fetching user quiz answers:", error);
    res.status(500).json({ 
      error: "Internal server error",
    });
  } 
  // finally {
  //   await db.$disconnect();
  // }
};