import { Router } from "express";
import { db, autoReplySessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import {
  startAutoReplySession,
  stopAutoReplySession,
  getAutoReplySessionStatus,
} from "../lib/auto-reply-scheduler";

const router = Router();

function getUserId(req: any): string | null {
  try { return getAuth(req)?.userId ?? null; } catch { return null; }
}

// GET /api/auto-reply/status
router.get("/status", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const status = getAutoReplySessionStatus(userId);
  const [row] = await db.select().from(autoReplySessionsTable).where(eq(autoReplySessionsTable.userId, userId)).limit(1);

  res.json({
    ...status,
    config: row ? {
      token: row.token ? "***" : "",
      persona: row.persona,
      fixedMessage: row.fixedMessage,
      triggerKeywords: row.triggerKeywords,
      maxRepliesPerUser: row.maxRepliesPerUser,
      maxRepliesPerCycle: row.maxRepliesPerCycle,
      activeHoursStart: row.activeHoursStart,
      activeHoursEnd: row.activeHoursEnd,
    } : null,
  });
});

// POST /api/auto-reply/start
router.post("/start", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const body = req.body as Record<string, unknown>;
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) { res.status(400).json({ error: "token required" }); return; }

  const persona = typeof body.persona === "string" ? body.persona : "";
  const fixedMessage = typeof body.fixedMessage === "string" ? body.fixedMessage : "";
  const triggerKeywords = typeof body.triggerKeywords === "string" ? body.triggerKeywords : "";
  const maxRepliesPerUser = typeof body.maxRepliesPerUser === "number" ? body.maxRepliesPerUser : 0;
  const maxRepliesPerCycle = typeof body.maxRepliesPerCycle === "number" ? body.maxRepliesPerCycle : 2;
  const activeHoursStart = typeof body.activeHoursStart === "number" ? body.activeHoursStart : 9;
  const activeHoursEnd = typeof body.activeHoursEnd === "number" ? body.activeHoursEnd : 23;
  const sentCountsByChannel = typeof body.sentCountsByChannel === "object" && body.sentCountsByChannel !== null
    ? JSON.stringify(body.sentCountsByChannel) : "{}";

  await db.insert(autoReplySessionsTable).values({
    userId, enabled: true, token, persona, fixedMessage, triggerKeywords,
    maxRepliesPerUser, maxRepliesPerCycle, activeHoursStart, activeHoursEnd,
    sentCountsByChannel, updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: autoReplySessionsTable.userId,
    set: {
      enabled: true, token, persona, fixedMessage, triggerKeywords,
      maxRepliesPerUser, maxRepliesPerCycle, activeHoursStart, activeHoursEnd,
      sentCountsByChannel, updatedAt: new Date(),
    },
  });

  let parsedCounts: Record<string, number> = {};
  try { parsedCounts = JSON.parse(sentCountsByChannel); } catch {}
  startAutoReplySession(userId, parsedCounts);

  res.json(getAutoReplySessionStatus(userId));
});

// POST /api/auto-reply/stop
router.post("/stop", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  stopAutoReplySession(userId);

  await db.update(autoReplySessionsTable)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(autoReplySessionsTable.userId, userId));

  res.json({ active: false });
});

export default router;
