import { Router } from "express";
import { db, campaignsTable, campaignLogsTable } from "@workspace/db";
import { eq, and, gte, desc, or, isNull } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { startCampaignSchedule, stopCampaignSchedule, isRunning, getNextSendAt, doSend } from "../scheduler";

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

function pickUA() {
  const agents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

function parseCampaignBody(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const channels = Array.isArray(body.channels) ? (body.channels as string[]).filter(Boolean) : [];
  const message = typeof body.message === "string" ? body.message : "";
  const delay = typeof body.delay === "number" ? Math.max(1, body.delay) : 15;
  const jitter = typeof body.jitter === "number" ? Math.min(100, Math.max(0, body.jitter)) : 0;
  const rateLimitProtection = typeof body.rateLimitProtection === "boolean" ? body.rateLimitProtection : undefined;
  return { name, token, channels, message, delay, jitter, rateLimitProtection };
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
  for (const r of todayCounts) {
    todayMap[r.campaignId] = (todayMap[r.campaignId] ?? 0) + 1;
  }

  res.json(rows.map((r) => serializeCampaign(r, todayMap[r.id] ?? 0)));
});

router.post("/", async (req, res) => {
  const userId = getUserId(req);
  const data = parseCampaignBody(req.body as Record<string, unknown>);
  if (!data.name || !data.token || !data.message) {
    res.status(400).json({ error: "name, token, and message are required" });
    return;
  }

  const [row] = await db
    .insert(campaignsTable)
    .values({
      userId,
      name: data.name,
      token: data.token,
      channels: data.channels,
      message: data.message,
      delay: data.delay,
      jitter: data.jitter,
      rateLimitProtection: data.rateLimitProtection ?? true,
    })
    .returning();

  res.status(201).json(serializeCampaign(row, 0));
});

router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const data = parseCampaignBody(req.body as Record<string, unknown>);
  const update: Record<string, unknown> = {};
  if (data.name) update.name = data.name;
  if (data.token) update.token = data.token;
  update.channels = data.channels;
  if (data.message) update.message = data.message;
  update.delay = data.delay;
  update.jitter = data.jitter;
  if (data.rateLimitProtection !== undefined) update.rateLimitProtection = data.rateLimitProtection;
  update.consecutiveFailures = 0;

  const [row] = await db
    .update(campaignsTable)
    .set(update)
    .where(eq(campaignsTable.id, id))
    .returning();

  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const sentToday = await getSentToday(id);
  res.json(serializeCampaign(row, sentToday));
});

router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  stopCampaignSchedule(id);
  await db.update(campaignsTable).set({ running: false }).where(eq(campaignsTable.id, id));
  await db.delete(campaignLogsTable).where(eq(campaignLogsTable.campaignId, id));
  await db.delete(campaignsTable).where(eq(campaignsTable.id, id));
  res.json({ success: true });
});

router.post("/:id/duplicate", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const userId = getUserId(req);
  const [original] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id)).limit(1);
  if (!original) { res.status(404).json({ error: "Not found" }); return; }

  const [row] = await db
    .insert(campaignsTable)
    .values({
      userId,
      name: `${original.name} (copy)`,
      token: original.token,
      channels: original.channels,
      message: original.message,
      delay: original.delay,
      jitter: original.jitter,
      rateLimitProtection: original.rateLimitProtection,
    })
    .returning();

  res.status(201).json(serializeCampaign(row, 0));
});

router.post("/:id/start", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .update(campaignsTable)
    .set({ running: true, consecutiveFailures: 0 })
    .where(eq(campaignsTable.id, id))
    .returning();

  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  startCampaignSchedule(id);
  const sentToday = await getSentToday(id);
  res.json(serializeCampaign(row, sentToday));
});

router.post("/:id/stop", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  stopCampaignSchedule(id);
  const [row] = await db
    .update(campaignsTable)
    .set({ running: false })
    .where(eq(campaignsTable.id, id))
    .returning();

  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const sentToday = await getSentToday(id);
  res.json(serializeCampaign(row, sentToday));
});

router.post("/:id/reset-stats", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .update(campaignsTable)
    .set({ sentCount: 0, failedCount: 0, rateLimitBonus: 0, consecutiveFailures: 0 })
    .where(eq(campaignsTable.id, id))
    .returning();

  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serializeCampaign(row, 0));
});

router.post("/:id/test-send", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id)).limit(1);
  if (!campaign) { res.status(404).json({ error: "Not found" }); return; }
  if (!campaign.token || campaign.channels.length === 0 || !campaign.message) {
    res.status(400).json({ error: "Campaign must have a token, channels, and message." });
    return;
  }

  const ua = pickUA();
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

  res.json(logs.map((l) => ({ ...l, timestamp: l.timestamp.toISOString() })));
});

router.delete("/:id/logs", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  await db.delete(campaignLogsTable).where(eq(campaignLogsTable.campaignId, id));
  res.json({ success: true });
});

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

  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const sentToday = await getSentToday(id);
  res.json(serializeCampaign(row, sentToday));
});

export default router;
