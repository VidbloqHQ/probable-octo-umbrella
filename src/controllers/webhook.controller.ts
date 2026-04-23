import { Request, Response } from "express";
import { WebhookReceiver } from "livekit-server-sdk";
import crypto from "crypto";
import { db, executeQuery, trackQuery } from "../prisma.js";

// ============================================
// LiveKit webhook receiver instance
// ============================================

const webhookReceiver = new WebhookReceiver(
  process.env.LIVEKIT_API_KEY!,
  process.env.LIVEKIT_API_SECRET!
);

// ============================================
// Event types we forward to tenants
// ============================================

const FORWARDED_EVENTS = [
  "room_started",
  "room_finished",
  "participant_joined",
  "participant_left",
];

// ============================================
// Sign a payload for tenant webhook delivery
// ============================================

function signPayload(payload: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
}

// ============================================
// Forward event to tenant's webhook URL
// ============================================

async function forwardToTenant(
  tenant: { id: string; webhookUrl: string; webhookSecret: string },
  event: {
    type: string;
    roomName: string;
    participantIdentity?: string;
    participantName?: string;
    timestamp: number;
    raw: any;
  }
) {
  const payload = JSON.stringify({
    event: event.type,
    roomName: event.roomName,
    participant: event.participantIdentity
      ? {
          identity: event.participantIdentity,
          name: event.participantName,
        }
      : undefined,
    timestamp: event.timestamp,
  });

  const signature = signPayload(payload, tenant.webhookSecret);

  try {
    const res = await fetch(tenant.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vidbloq-signature": signature,
        "x-vidbloq-timestamp": String(event.timestamp),
      },
      body: payload,
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!res.ok) {
      console.error(
        `[WEBHOOK] Delivery failed for tenant ${tenant.id}: ${res.status} ${res.statusText}`
      );
    } else {
      console.log(
        `[WEBHOOK] Delivered ${event.type} to tenant ${tenant.id} (room: ${event.roomName})`
      );
    }
  } catch (err) {
    console.error(
      `[WEBHOOK] Delivery error for tenant ${tenant.id}:`,
      err instanceof Error ? err.message : err
    );
  }
}

// ============================================
// POST /webhooks/livekit — receive LiveKit webhooks
// ============================================

export const handleLivekitWebhook = async (req: Request, res: Response) => {
  let success = false;

  try {
    // Verify the webhook signature from LiveKit
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Missing authorization header" });
    }

    // LiveKit sends the raw body — we need it as a string for verification
    const rawBody =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);

    let event: any;
    try {
      event = await webhookReceiver.receive(rawBody, authHeader);
    } catch (err) {
      console.error("[WEBHOOK] LiveKit signature verification failed:", err);
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    // Acknowledge immediately — processing happens async
    res.status(200).json({ received: true });

    // Only forward events we care about
    if (!FORWARDED_EVENTS.includes(event.event)) {
      return;
    }

    const roomName = event.room?.name;
    if (!roomName) {
      console.warn("[WEBHOOK] Event missing room name:", event.event);
      return;
    }

    console.log(`[WEBHOOK] Received ${event.event} for room ${roomName}`);

    // Look up which tenant owns this room
    const stream = await executeQuery(
      () =>
        db.stream.findFirst({
          where: { name: roomName },
          select: {
            tenantId: true,
            tenant: {
              select: {
                id: true,
                webhookUrl: true,
                webhookSecret: true,
              },
            },
          },
        }),
      { maxRetries: 1, timeout: 3000 }
    );

    if (!stream) {
      console.warn(`[WEBHOOK] No stream found for room: ${roomName}`);
      return;
    }

    const tenant = stream.tenant;

    // Only forward if tenant has a webhook URL configured
    if (!tenant.webhookUrl || !tenant.webhookSecret) {
      return;
    }

    const webhookTenant = tenant as { id: string; webhookUrl: string; webhookSecret: string };

    // Build normalized event
    const normalizedEvent = {
      type: event.event,
      roomName,
      participantIdentity: event.participant?.identity,
      participantName: event.participant?.name,
      timestamp: Date.now(),
      raw: event,
    };

    // Forward to tenant (fire and forget — we already responded 200)
    forwardToTenant(webhookTenant, normalizedEvent).catch((err) => {
      console.error("[WEBHOOK] Forward failed:", err);
    });

    // Update stream state based on event
    if (event.event === "room_finished") {
      await executeQuery(
        () =>
          db.stream.updateMany({
            where: { name: roomName },
            data: {
              isLive: false,
              endedAt: new Date(),
            },
          }),
        { maxRetries: 1, timeout: 3000 }
      ).catch((err) => {
        console.error("[WEBHOOK] Failed to update stream on room_finished:", err);
      });
    }

    if (event.event === "participant_left") {
      const participantIdentity = event.participant?.identity;
      if (participantIdentity) {
        await executeQuery(
          () =>
            db.participant.updateMany({
              where: {
                id: participantIdentity,
                leftAt: null,
              },
              data: {
                leftAt: new Date(),
              },
            }),
          { maxRetries: 1, timeout: 3000 }
        ).catch((err) => {
          console.error("[WEBHOOK] Failed to update participant on leave:", err);
        });
      }
    }

    success = true;
  } catch (err) {
    console.error("[WEBHOOK] Unhandled error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Internal server error" });
    }
  } finally {
    trackQuery(success);
  }
};

// ============================================
// Tenant webhook registration
// ============================================

/**
 * Generate a random webhook secret for a tenant
 */
function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString("hex")}`;
}

/**
 * PUT /tenant/me/webhook — register or update webhook URL
 * Called by authenticated tenants
 */
export const registerWebhook = async (req: any, res: Response) => {
  let success = false;

  try {
    const tenant = req.tenant;
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required" });
    }

    const { webhookUrl } = req.body;
    if (!webhookUrl) {
      return res.status(400).json({ error: "webhookUrl is required" });
    }

    // Validate URL format
    try {
      new URL(webhookUrl);
    } catch {
      return res.status(400).json({ error: "Invalid webhook URL format" });
    }

    // Generate a new secret if the tenant doesn't have one
    const existingTenant = await executeQuery(
      () =>
        db.tenant.findUnique({
          where: { id: tenant.id },
          select: { webhookSecret: true },
        }),
      { maxRetries: 1, timeout: 3000 }
    );

    const webhookSecret =
      existingTenant?.webhookSecret || generateWebhookSecret();

    await executeQuery(
      () =>
        db.tenant.update({
          where: { id: tenant.id },
          data: { webhookUrl, webhookSecret },
        }),
      { maxRetries: 2, timeout: 5000 }
    );

    success = true;
    return res.status(200).json({
      webhookUrl,
      webhookSecret, // Tenant needs this to verify incoming webhooks
      message: "Webhook registered successfully",
    });
  } catch (err) {
    console.error("[WEBHOOK] Registration error:", err);
    return res.status(500).json({ error: "Failed to register webhook" });
  } finally {
    trackQuery(success);
  }
};

/**
 * DELETE /tenant/me/webhook — remove webhook configuration
 */
export const removeWebhook = async (req: any, res: Response) => {
  let success = false;

  try {
    const tenant = req.tenant;
    if (!tenant) {
      return res.status(401).json({ error: "Tenant authentication required" });
    }

    await executeQuery(
      () =>
        db.tenant.update({
          where: { id: tenant.id },
          data: { webhookUrl: null, webhookSecret: null },
        }),
      { maxRetries: 2, timeout: 5000 }
    );

    success = true;
    return res.status(200).json({ message: "Webhook removed" });
  } catch (err) {
    console.error("[WEBHOOK] Remove error:", err);
    return res.status(500).json({ error: "Failed to remove webhook" });
  } finally {
    trackQuery(success);
  }
};