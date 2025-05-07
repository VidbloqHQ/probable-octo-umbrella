// In services/participantReconciliation.ts
import { db } from "../prisma.js";
import { ParticipantManager } from "./participantManager.js";
import { clientsByIdentity, activeParticipants } from "../websocket.js";

/**
 * Reconciles participant status by checking for participants marked as 'left'
 * but still active in WebSocket connections
 */
export const reconcileParticipantStatus = async () => {
  try {
    console.log("Running participant status reconciliation job");
    
    // Get all active streams
    const activeStreams = await db.stream.findMany({
      where: { isLive: true },
      include: { participants: true },
    });

    let correctionCount = 0;

    for (const stream of activeStreams) {
      // 1. First, check if participants marked as active are still connected
      if (activeParticipants[stream.name]) {
        const activeIds = Object.keys(activeParticipants[stream.name]);
        
        // Check activity timestamps - if older than 5 minutes, they're likely gone
        const now = Date.now();
        for (const participantId of activeIds) {
          const lastActivity = activeParticipants[stream.name][participantId];
          if (now - lastActivity > 5 * 60 * 1000) { // 5 minutes
            // This participant is inactive - mark them as left
            const participant = stream.participants.find(p => p.id === participantId);
            if (participant && !participant.leftAt) {
              await ParticipantManager.markParticipantAsLeft(
                stream.name, 
                participant.walletAddress, 
                participantId
              );
              console.log(`Marked inactive participant ${participantId} as left`);
            }
          }
        }
      }

      // 2. Check participants marked as 'left' but still active
      const participantsToCheck = stream.participants.filter(p => p.leftAt);
      
      for (const participant of participantsToCheck) {
        const isStillActive = Boolean(
          clientsByIdentity[participant.id] && 
          activeParticipants[stream.name]?.[participant.id] &&
          Date.now() - activeParticipants[stream.name][participant.id] < 2 * 60 * 1000 // 2 minutes
        );
          
        if (isStillActive) {
          // Participant is actually still active, reset their leftAt time
          await db.participant.update({
            where: { id: participant.id },
            data: { leftAt: null },
          });
          
          correctionCount++;
          console.log(`Corrected status for still-active participant ${participant.id} in stream ${stream.name}`);
        }
      }
    }

    console.log(`Reconciliation complete. Corrected ${correctionCount} participant statuses.`);
  } catch (error) {
    console.error("Error reconciling participant status:", error);
  } finally {
    await db.$disconnect();
  }
};

// Run reconciliation more frequently to catch issues sooner
export const startReconciliationJob = () => {
  // Run every 2 minutes
  setInterval(reconcileParticipantStatus, 2 * 60 * 1000);
  console.log("Participant reconciliation job scheduled (every 2 minutes)");
};