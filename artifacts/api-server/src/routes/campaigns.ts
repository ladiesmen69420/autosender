import { Router } from "express";
import { db, campaignsTable, campaignLogsTable } from "@workspace/db";
import { eq, and, gte, desc, or, isNull } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { startCampaignSchedule, startIndependentSchedule, stopCampaignSchedule, getNextSendAt, doSend } from "../scheduler";
import { pickStableUA } from "../lib/discord-headers";

const router = Router();

function getUserId(req: any): string | null {
  try {
    const auth = getAuth(req);
    return auth?.userId ?? null;
  } catch {
    return null;
  }
}

function userFilter(userId: string | null) {
  if (!userId) return isNull(campaignsTable.userId);
  return or(eq(campaignsTable.userId, userId), isNull(campaignsTable.userId));
}

/* ─── Validation helpers ─────────────────────────────────────────────────── */

function parseHHMM(s: string | null | undefined): number | null {
  if (!s) return null;
  const raw = s.trim().toLowerCase();
  const m12 = /^(\d{1,2}):(\d{2})\s*([ap]m)$/.exec(raw);
  if (m12) {
    let h = parseInt(m12[1], 10) % 12;
    const min = parseInt(m12[2], 10);
    if (min < 0 || min > 59) return null;
    if (m12[3] === "pm") h += 12;
    return h * 60 + min;
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function validateSendWindow(start: string | null, end: string | null): string | null {
  if (start && parseHHMM(start) === null) return `Invalid send window start time "${start}". Use HH:MM or H:MM AM/PM format.`;
  if (end && parseHHMM(end) === null) return `Invalid send window end time "${end}". Use HH:MM or H:MM AM/PM format.`;
  if ((start && !end) || (!start && end)) return "Both send window start and end must be provided together.";
  return null;
}

function validateChannels(channels: string[]): string | null {
  if (channels.length === 0) return "At least one channel ID is required.";
  const invalid = channels.filter((ch) => !/^\d{15,20}$/.test(ch));
  if (invalid.length > 0) return `Invalid channel IDs: ${invalid.join(", ")}. Channel IDs must be 15–20 digit numbers.`;
  return null;
}

function validateMessage(message: string): string | null {
  if (!message.trim()) return "Message cannot be empty.";
  if (message.length > 2000) return "Message exceeds Discord's 2000-character limit.";
  return null;
}

function validateDelay(delay: unknown): string | null {
  if (typeof delay !== "number" || isNaN(delay) || delay < 1 || delay > 18000)
    return "Interval must be between 1 and 18000 seconds.";
  return null;
}

function validateJitter(jitter: unknown): string | null {
  if (typeof jitter !== "number" || isNaN(jitter) || jitter < 0 || jitter > 100)
    return "Jitter must be between 0 and 100 percent.";
  return null;
}

async function getSentToday(campaignId: number): Promise<number> {
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const rows = await db
    .select({ id: campaignLogsTable.id })
    .from(campaignLogsTable)
    .where(
      and(
        eq(campaignLogsTable.campaignId, campaignId),
        eq(campaignLogsTable.type, "success"),
        gte(campaignLogsTable.timestamp, todayMidnight),
      ),
    );
  return rows.length;
}

function serializeCampaign(row: typeof campaignsTable.$inferSelect, sentToday = 0) {
  const nextSendAt = getNextSendAt(row.id);
  return {
    ...row,
    running: row.running,
    sentToday,
    nextSendAt: nextSendAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    lastSentAt: row.lastSentAt ? row.lastSentAt.toISOString() : null,
  };
}

/* ─── GET / ──────────────────────────────────────────────────────────────── */
router.get("/", async (req, res) => {
  const userId = getUserId(req);
  const filter = userFilter(userId);
  const rows = await db.select().from(campaignsTable).where(filter).orderBy(campaignsTable.createdAt);
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);

  const todayCounts = await db
    .select({ campaignId: campaignLogsTable.campaignId, id: campaignLogsTable.id })
    .from(campaignLogsTable)
    .where(and(eq(campaignLogsTable.type, "success"), gte(campaignLogsTable.timestamp, todayMidnight)));

  const todayMap: Record<number, number> = {};
  for (const r of todayCounts as Array<{ campaignId: number; id: number }>) {
    todayMap[r.campaignId] = (todayMap[r.campaignId] ?? 0) + 1;
  }

  res.json(rows.map((r: Parameters<typeof serializeCampaign>[0]) => serializeCampaign(r, todayMap[r.id] ?? 0)));
});

/* ─── POST / (create) ────────────────────────────────────────────────────── */
router.post("/", async (req, res) => {
  const userId = getUserId(req);
  const body = req.body as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const rawChannels = Array.isArray(body.channels) ? (body.channels as string[]).map((c) => String(c).trim()).filter(Boolean) : [];
  const message = typeof body.message === "string" ? body.message : "";
  const messageVariants = Array.isArray(body.messageVariants)
    ? (body.messageVariants as string[]).map((v) => String(v).trim()).filter(Boolean)
    : null;
  const delay = typeof body.delay === "number" ? body.delay : 15;
  const jitter = typeof body.jitter === "number" ? body.jitter : 0;
  const rateLimitProtection = typeof body.rateLimitProtection === "boolean" ? body.rateLimitProtection : true;
  const sendWindowStart = typeof body.sendWindowStart === "string" && body.sendWindowStart.trim() ? body.sendWindowStart.trim() : null;
  const sendWindowEnd = typeof body.sendWindowEnd === "string" && body.sendWindowEnd.trim() ? body.sendWindowEnd.trim() : null;
  const rotateEnabled = typeof body.rotateEnabled === "boolean" ? body.rotateEnabled : true;

  if (!name) { res.status(400).json({ error: "Validation failed", details: "Campaign name is required." }); return; }
  if (!token) { res.status(400).json({ error: "Validation failed", details: "Discord token is required." }); return; }

  const channelErr = validateChannels(rawChannels);
  if (channelErr) { res.status(400).json({ error: "Validation failed", details: channelErr }); return; }

  const msgErr = validateMessage(message);
  if (msgErr) { res.status(400).json({ error: "Validation failed", details: msgErr }); return; }

  const delayErr = validateDelay(delay);
  if (delayErr) { res.status(400).json({ error: "Validation failed", details: delayErr }); return; }

  const jitterErr = validateJitter(jitter);
  if (jitterErr) { res.status(400).json({ error: "Validation failed", details: jitterErr }); return; }

  const winErr = validateSendWindow(sendWindowStart, sendWindowEnd);
  if (winErr) { res.status(400).json({ error: "Validation failed", details: winErr }); return; }

  try {
    const [row] = await db
      .insert(campaignsTable)
      .values({
        userId,
        name,
        token,
        channels: rawChannels,
        message,
        messageVariants: messageVariants ?? null,
        delay,
        jitter,
        rateLimitProtection,
        sendWindowStart,
        sendWindowEnd,
        rotateEnabled,
      })
      .returning();

    res.status(201).json(serializeCampaign(row, 0));
  } catch (err) {
    req.log.error({ campaignName: name, err }, "Failed to insert campaign");
    res.status(500).json({ error: "Failed to create campaign", details: "A database error occurred. Please try again." });
  }
});

/* ─── PUT /:id (update) ──────────────────────────────────────────────────── */
router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const body = req.body as Record<string, unknown>;
  const update: Record<string, unknown> = { consecutiveFailures: 0 };

  if ("name" in body) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) { res.status(400).json({ error: "Validation failed", details: "Campaign name cannot be empty." }); return; }
    update.name = name;
  }
  if ("token" in body) {
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) { res.status(400).json({ error: "Validation failed", details: "Discord token cannot be empty." }); return; }
    update.token = token;
  }
  if ("channels" in body) {
    const channels = Array.isArray(body.channels) ? (body.channels as string[]).map((c) => String(c).trim()).filter(Boolean) : [];
    const channelErr = validateChannels(channels);
    if (channelErr) { res.status(400).json({ error: "Validation failed", details: channelErr }); return; }
    update.channels = channels;
  }
  if ("message" in body) {
    const message = typeof body.message === "string" ? body.message : "";
    const msgErr = validateMessage(message);
    if (msgErr) { res.status(400).json({ error: "Validation failed", details: msgErr }); return; }
    update.message = message;
  }
  if ("messageVariants" in body) {
    update.messageVariants = Array.isArray(body.messageVariants)
      ? (body.messageVariants as string[]).map((v) => String(v).trim()).filter(Boolean)
      : null;
  }
  if ("delay" in body) {
    const delayErr = validateDelay(body.delay);
    if (delayErr) { res.status(400).json({ error: "Validation failed", details: delayErr }); return; }
    update.delay = body.delay as number;
  }
  if ("jitter" in body) {
    const jitterErr = validateJitter(body.jitter);
    if (jitterErr) { res.status(400).json({ error: "Validation failed", details: jitterErr }); return; }
    update.jitter = body.jitter as number;
  }
  if ("rateLimitProtection" in body) {
    update.rateLimitProtection = typeof body.rateLimitProtection === "boolean" ? body.rateLimitProtection : true;
  }
  if ("sendWindowStart" in body || "sendWindowEnd" in body) {
    const start = "sendWindowStart" in body
      ? (typeof body.sendWindowStart === "string" && body.sendWindowStart.trim() ? body.sendWindowStart.trim() : null)
      : undefined;
    const end = "sendWindowEnd" in body
      ? (typeof body.sendWindowEnd === "string" && body.sendWindowEnd.trim() ? body.sendWindowEnd.trim() : null)
      : undefined;
    const winErr = validateSendWindow(start ?? null, end ?? null);
    if (winErr) { res.status(400).json({ error: "Validation failed", details: winErr }); return; }
    if (start !== undefined) update.sendWindowStart = start;
    if (end !== undefined) update.sendWindowEnd = end;
  }
  if ("rotateEnabled" in body) {
    update.rotateEnabled = typeof body.rotateEnabled === "boolean" ? body.rotateEnabled : true;
  }

  try {
    const [row] = await db
      .update(campaignsTable)
      .set(update)
      .where(eq(campaignsTable.id, id))
      .returning();

    if (!row) { res.status(404).json({ error: "Campaign not found" }); return; }
    const sentToday = await getSentToday(id);
    res.json(serializeCampaign(row, sentToday));
  } catch (err) {
    req.log.error({ campaignId: id, err }, "Failed to update campaign");
    res.status(500).json({ error: "Failed to update campaign", details: "A database error occurred. Please try again." });
  }
});

/* ─── DELETE /:id ────────────────────────────────────────────────────────── */
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  stopCampaignSchedule(id);
  await db.update(campaignsTable).set({ running: false }).where(eq(campaignsTable.id, id));
  await db.delete(campaignLogsTable).where(eq(campaignLogsTable.campaignId, id));
  await db.delete(campaignsTable).where(eq(campaignsTable.id, id));
  res.json({ success: true });
});

/* ─── POST /:id/duplicate ────────────────────────────────────────────────── */
router.post("/:id/duplicate", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const userId = getUserId(req);
  const [original] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id)).limit(1);
  if (!original) { res.status(404).json({ error: "Campaign not found" }); return; }

  try {
    const [row] = await db
      .insert(campaignsTable)
      .values({
        userId,
        name: `${original.name} (copy)`,
        token: original.token,
        channels: original.channels,
        message: original.message,
        messageVariants: original.messageVariants ?? null,
        delay: original.delay,
        jitter: original.jitter,
        rateLimitProtection: original.rateLimitProtection,
        sendWindowStart: original.sendWindowStart,
        sendWindowEnd: original.sendWindowEnd,
        rotateEnabled: original.rotateEnabled,
        // Runtime stats reset to zero (sentCount, failedCount, rateLimitBonus, etc. use defaults)
      })
      .returning();

    res.status(201).json(serializeCampaign(row, 0));
  } catch (err) {
    req.log.error({ campaignId: id, err }, "Failed to duplicate campaign");
    res.status(500).json({ error: "Failed to duplicate campaign", details: "A database error occurred." });
  }
});

/* ─── POST /:id/start ────────────────────────────────────────────────────── */
router.post("/:id/start", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id)).limit(1);
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }

  // Validate all required fields before starting
  if (!campaign.token || !campaign.token.trim()) {
    res.status(400).json({ error: "Cannot start", details: "Campaign has no Discord token. Edit the campaign and add a valid token." });
    return;
  }
  const channelErr = validateChannels(campaign.channels);
  if (channelErr) { res.status(400).json({ error: "Cannot start", details: channelErr }); return; }

  const msgErr = validateMessage(campaign.message);
  if (msgErr) { res.status(400).json({ error: "Cannot start", details: msgErr }); return; }

  const delayErr = validateDelay(campaign.delay);
  if (delayErr) { res.status(400).json({ error: "Cannot start", details: delayErr }); return; }

  const jitterErr = validateJitter(campaign.jitter);
  if (jitterErr) { res.status(400).json({ error: "Cannot start", details: jitterErr }); return; }

  const winErr = validateSendWindow(campaign.sendWindowStart, campaign.sendWindowEnd);
  if (winErr) { res.status(400).json({ error: "Cannot start", details: winErr }); return; }

  try {
    const [row] = await db
      .update(campaignsTable)
      .set({ running: true, consecutiveFailures: 0 })
      .where(eq(campaignsTable.id, id))
      .returning();

    if (!row) { res.status(404).json({ error: "Campaign not found" }); return; }

    if (campaign.rotateEnabled) {
      startCampaignSchedule(id);
    } else {
      startIndependentSchedule(id);
    }
    const sentToday = await getSentToday(id);
    res.json(serializeCampaign(row, sentToday));
  } catch (err) {
    req.log.error({ campaignId: id, err }, "Failed to start campaign");
    res.status(500).json({ error: "Failed to start campaign", details: "A database error occurred." });
  }
});

/* ─── POST /:id/stop ─────────────────────────────────────────────────────── */
router.post("/:id/stop", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  stopCampaignSchedule(id);

  try {
    const [row] = await db
      .update(campaignsTable)
      .set({ running: false })
      .where(eq(campaignsTable.id, id))
      .returning();

    if (!row) { res.status(404).json({ error: "Campaign not found" }); return; }
    const sentToday = await getSentToday(id);
    res.json(serializeCampaign(row, sentToday));
  } catch (err) {
    req.log.error({ campaignId: id, err }, "Failed to stop campaign");
    res.status(500).json({ error: "Failed to stop campaign", details: "A database error occurred." });
  }
});

/* ─── POST /:id/reset-stats ──────────────────────────────────────────────── */
router.post("/:id/reset-stats", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .update(campaignsTable)
    .set({ sentCount: 0, failedCount: 0, rateLimitBonus: 0, consecutiveFailures: 0 })
    .where(eq(campaignsTable.id, id))
    .returning();

  if (!row) { res.status(404).json({ error: "Campaign not found" }); return; }
  res.json(serializeCampaign(row, 0));
});

/* ─── POST /:id/test-send ────────────────────────────────────────────────── */
router.post("/:id/test-send", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id)).limit(1);
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }

  if (!campaign.token) { res.status(400).json({ error: "Cannot test", details: "Campaign has no token." }); return; }
  const channelErr = validateChannels(campaign.channels);
  if (channelErr) { res.status(400).json({ error: "Cannot test", details: channelErr }); return; }
  const msgErr = validateMessage(campaign.message);
  if (msgErr) { res.status(400).json({ error: "Cannot test", details: msgErr }); return; }

  const ua = pickStableUA(campaign.token);
  const results: { channelId: string; success: boolean; status: number; error?: string; suggestion?: string }[] = [];

  for (const channelId of campaign.channels) {
    try {
      const result = await doSend(campaign.token, channelId, `[TEST] ${campaign.message}`, ua);

      let errorMsg: string | undefined;
      let suggestion: string | undefined;

      if (!result.ok) {
        const statusInfo: Record<number, { error: string; suggestion: string }> = {
          401: { error: "Invalid or expired token", suggestion: "Update your Discord token in campaign settings." },
          403: { error: "Missing permissions", suggestion: "Your account can't send messages here. Check channel permissions." },
          404: { error: "Channel not found", suggestion: "The channel ID is wrong or the channel was deleted." },
          429: { error: "Rate limited", suggestion: "Slow down. Enable rate limit protection or increase interval." },
        };
        const info = statusInfo[result.status] ?? { error: `HTTP ${result.status}`, suggestion: "Check your token and channel IDs." };
        errorMsg = info.error;
        suggestion = info.suggestion;
        await db.insert(campaignLogsTable).values({ campaignId: id, type: "error", message: `[TEST] ${info.error}`, channelId, details: `HTTP ${result.status}`, suggestion: info.suggestion });
      } else {
        await db.insert(campaignLogsTable).values({ campaignId: id, type: "success", message: `[TEST] Message sent successfully to channel ${channelId}`, channelId });
      }

      results.push({ channelId, success: result.ok, status: result.status, error: errorMsg, suggestion });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ channelId, success: false, status: 0, error: "Network error: " + msg, suggestion: "Check your internet connection." });
      await db.insert(campaignLogsTable).values({ campaignId: id, type: "error", message: `[TEST] Network error`, channelId, details: msg, suggestion: "Check internet connection." });
    }
  }

  res.json({ results });
});

/* ─── GET /:id/logs ──────────────────────────────────────────────────────── */
router.get("/:id/logs", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const type = typeof req.query.type === "string" ? req.query.type : undefined;
  const since = req.query.since === "today" ? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })() : undefined;

  const conditions = [eq(campaignLogsTable.campaignId, id)];
  if (type && ["success", "warning", "error"].includes(type)) {
    conditions.push(eq(campaignLogsTable.type, type));
  }
  if (since) {
    conditions.push(gte(campaignLogsTable.timestamp, since));
  }

  const logs = await db
    .select()
    .from(campaignLogsTable)
    .where(and(...conditions))
    .orderBy(desc(campaignLogsTable.timestamp))
    .limit(500);

  res.json(logs.map((l: { timestamp: Date; [k: string]: unknown }) => ({ ...l, timestamp: l.timestamp.toISOString() })));
});

/* ─── DELETE /:id/logs ───────────────────────────────────────────────────── */
router.delete("/:id/logs", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  await db.delete(campaignLogsTable).where(eq(campaignLogsTable.campaignId, id));
  res.json({ success: true });
});

/* ─── PATCH /:id/rate-limit-protection ───────────────────────────────────── */
router.patch("/:id/rate-limit-protection", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const body = req.body as Record<string, unknown>;
  const enabled = typeof body.enabled === "boolean" ? body.enabled : true;

  const [row] = await db
    .update(campaignsTable)
    .set({ rateLimitProtection: enabled, ...(enabled ? {} : { rateLimitBonus: 0 }) })
    .where(eq(campaignsTable.id, id))
    .returning();

  if (!row) { res.status(404).json({ error: "Campaign not found" }); return; }
  const sentToday = await getSentToday(id);
  res.json(serializeCampaign(row, sentToday));
});

export default router;
