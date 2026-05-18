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

function validateAutoReplySettings(body: Record<string, unknown>): string | null {
  const maxRepliesPerUser = body.maxRepliesPerUser;
  if (maxRepliesPerUser !== undefined && typeof maxRepliesPerUser !== "number") {
    return "maxRepliesPerUser must be a number.";
  }
  if (typeof maxRepliesPerUser === "number" && (maxRepliesPerUser < 0 || maxRepliesPerUser > 1000)) {
    return "maxRepliesPerUser must be between 0 and 1000.";
  }

  const maxRepliesPerCycle = body.maxRepliesPerCycle;
  if (maxRepliesPerCycle !== undefined && typeof maxRepliesPerCycle !== "number") {
    return "maxRepliesPerCycle must be a number.";
  }
  if (typeof maxRepliesPerCycle === "number" && (maxRepliesPerCycle < 1 || maxRepliesPerCycle > 50)) {
    return "maxRepliesPerCycle must be between 1 and 50.";
  }

  const activeHoursStart = body.activeHoursStart;
  const activeHoursEnd = body.activeHoursEnd;
  if (activeHoursStart !== undefined && (typeof activeHoursStart !== "number" || activeHoursStart < 0 || activeHoursStart > 23)) {
    return "activeHoursStart must be a number between 0 and 23 (SGT hour).";
  }
  if (activeHoursEnd !== undefined && (typeof activeHoursEnd !== "number" || activeHoursEnd < 0 || activeHoursEnd > 23)) {
    return "activeHoursEnd must be a number between 0 and 23 (SGT hour).";
  }

  const triggerKeywords = body.triggerKeywords;
  if (triggerKeywords !== undefined && typeof triggerKeywords !== "string") {
    return "triggerKeywords must be a comma-separated string.";
  }
  if (typeof triggerKeywords === "string" && triggerKeywords.length > 2000) {
    return "triggerKeywords is too long (max 2000 characters).";
  }

  return null;
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

  const validationErr = validateAutoReplySettings(body);
  if (validationErr) { res.status(400).json({ error: "Validation failed", details: validationErr }); return; }

  const persona = typeof body.persona === "string" ? body.persona : "";
  const fixedMessage = typeof body.fixedMessage === "string" ? body.fixedMessage : "";
  const triggerKeywords = typeof body.triggerKeywords === "string" ? body.triggerKeywords : "";
  const maxRepliesPerUser = typeof body.maxRepliesPerUser === "number" ? body.maxRepliesPerUser : 0;
  const maxRepliesPerCycle = typeof body.maxRepliesPerCycle === "number" ? body.maxRepliesPerCycle : 2;
  const activeHoursStart = typeof body.activeHoursStart === "number" ? body.activeHoursStart : 9;
  const activeHoursEnd = typeof body.activeHoursEnd === "number" ? body.activeHoursEnd : 23;
  const sentCountsByChannel = typeof body.sentCountsByChannel === "object" && body.sentCountsByChannel !== null
    ? JSON.stringify(body.sentCountsByChannel) : "{}";

  try {
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
  } catch (err) {
    req.log.error({ err }, "Failed to save auto-reply session");
    res.status(500).json({ error: "Failed to save settings", details: "A database error occurred." });
    return;
  }

  let parsedCounts: Record<string, number> = {};
  try { parsedCounts = JSON.parse(sentCountsByChannel); } catch {}
  startAutoReplySession(userId, parsedCounts);

  res.json(getAutoReplySessionStatus(userId));
});

// POST /api/auto-reply/stop
router.post("/stop", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  // Stop the session immediately (sets cancelled flag to abort pending waits/sends)
  stopAutoReplySession(userId);

  try {
    await db.update(autoReplySessionsTable)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(autoReplySessionsTable.userId, userId));
  } catch (err) {
    req.log.error({ err }, "Failed to update auto-reply session status");
  }

  res.json({ active: false });
});

export default router;
