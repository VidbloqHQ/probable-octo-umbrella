import { db } from "../prisma.js";
import { ParticipantManager } from "./participantManager.js";
import { clientsByIdentity, activeParticipants } from "../websocket.js";

/**
 * Reconciles participant status by checking for participants marked as 'left'
 * but still active in WebSocket connections and vice versa
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
    let cleanupCount = 0;

    for (const stream of activeStreams) {
      // 1. Check all participants who haven't left yet
      const activeParticipantsInDb = stream.participants.filter(p => !p.leftAt);
      
      for (const participant of activeParticipantsInDb) {
        // Check multiple ways to find the participant's connection
        const hasWebSocketById = Boolean(clientsByIdentity[participant.id]);
        const hasWebSocketByName = Boolean(clientsByIdentity[participant.userName]);
        const hasWebSocketConnection = hasWebSocketById || hasWebSocketByName;
        
        // Check activity by both ID and userName
        const lastActivityById = activeParticipants[stream.name]?.[participant.id];
        const lastActivityByName = activeParticipants[stream.name]?.[participant.userName];
        const lastActivity = lastActivityById || lastActivityByName;
        
        const now = Date.now();
        
        // More lenient activity check - 5 minutes
        const ACTIVITY_THRESHOLD = 5 * 60 * 1000; // 5 minutes
        
        // Check if participant is truly inactive
        const isInactive = !hasWebSocketConnection && 
                          (!lastActivity || (now - lastActivity > ACTIVITY_THRESHOLD));
        
        if (isInactive) {
          // This participant is not active - mark them as left
          const timeSinceActivity = lastActivity ? 
            `${Math.round((now - lastActivity) / 1000)}` : 
            'never seen';
          console.log(`Marking inactive participant ${participant.id} (${participant.userName}) as left (last activity: ${timeSinceActivity} seconds ago)`);
          
          await ParticipantManager.markParticipantAsLeft(
            stream.name, 
            participant.walletAddress, 
            participant.id
          );
          
          // Clean up WebSocket state by both ID and name
          ParticipantManager.cleanupWebSocketState(stream.name, participant.id);
          ParticipantManager.cleanupWebSocketState(stream.name, participant.userName);
          
          cleanupCount++;
        }
      }
      
      // 2. Check participants marked as 'left' but still active (edge case)
      const leftParticipants = stream.participants.filter(p => p.leftAt);
      
      for (const participant of leftParticipants) {
        // Check if still active by ID or name
        const isStillActiveById = Boolean(
          clientsByIdentity[participant.id] && 
          activeParticipants[stream.name]?.[participant.id] &&
          Date.now() - activeParticipants[stream.name][participant.id] < 2 * 60 * 1000
        );
        
        const isStillActiveByName = Boolean(
          clientsByIdentity[participant.userName] && 
          activeParticipants[stream.name]?.[participant.userName] &&
          Date.now() - activeParticipants[stream.name][participant.userName] < 2 * 60 * 1000
        );
        
        const isStillActive = isStillActiveById || isStillActiveByName;
          
        if (isStillActive) {
          // Participant is actually still active, reset their leftAt time
          await db.participant.update({
            where: { id: participant.id },
            data: { leftAt: null },
          });
          
          correctionCount++;
          console.log(`Corrected status for still-active participant ${participant.id} (${participant.userName}) in stream ${stream.name}`);
        }
      }
      
      // 3. Clean up orphaned WebSocket connections
      if (activeParticipants[stream.name]) {
        const activeIds = Object.keys(activeParticipants[stream.name]);
        const dbParticipantIds = stream.participants.map(p => p.id);
        const dbParticipantNames = stream.participants.map(p => p.userName);
        
        for (const activeId of activeIds) {
          // Check if this activeId matches any participant ID or name
          if (!dbParticipantIds.includes(activeId) && !dbParticipantNames.includes(activeId)) {
            console.log(`Found orphaned WebSocket connection for ${activeId}, cleaning up`);
            ParticipantManager.cleanupWebSocketState(stream.name, activeId);
            cleanupCount++;
          }
        }
      }
    }

    if (correctionCount > 0 || cleanupCount > 0) {
      console.log(`Reconciliation complete. Corrected ${correctionCount} statuses, cleaned up ${cleanupCount} inactive participants.`);
    }
  } catch (error) {
    console.error("Error reconciling participant status:", error);
  }
};

/**
 * Enhanced reconciliation job that runs periodically
 */
export const startEnhancedReconciliationJob = () => {
  // Don't run immediately - wait for participants to establish connections
  setTimeout(reconcileParticipantStatus, 5 * 60 * 1000); // 5 minutes delay on startup
  
  // Run every 2 minutes after that
  const interval = setInterval(reconcileParticipantStatus, 2 * 60 * 1000);
  
  console.log("Enhanced participant reconciliation job scheduled (first run in 5 minutes, then every 2 minutes)");
  
  // Return cleanup function
  return () => {
    clearInterval(interval);
  };
};