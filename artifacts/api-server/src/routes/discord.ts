import { Router } from "express";
import { db } from "@workspace/db";
import { sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  ValidateTokenBody,
  SendMessagesBody,
  CreateSessionBody,
  DeleteSessionParams,
} from "@workspace/api-zod";

const router = Router();

router.post("/validate-token", async (req, res) => {
  const parsed = ValidateTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ valid: false, error: "Invalid request body" });
    return;
  }

  const { token } = parsed.data;

  try {
    const response = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: token },
    });

    if (response.ok) {
      const user = (await response.json()) as {
        username: string;
        discriminator: string;
        id: string;
        avatar: string | null;
      };
      res.json({
        valid: true,
        username: user.username,
        discriminator: user.discriminator,
        id: user.id,
        avatar: user.avatar,
      });
    } else {
      res.json({ valid: false, error: "Invalid token" });
    }
  } catch (err) {
    req.log.error({ err }, "Token validation error");
    res.json({ valid: false, error: "Failed to reach Discord API" });
  }
});

router.post("/send-messages", async (req, res) => {
  const parsed = SendMessagesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ sent: 0, failed: 0, results: [] });
    return;
  }

  const { token, channels, message, repeatBypass } = parsed.data;
  const results: Array<{ channelId: string; success: boolean; error?: string }> = [];
  let sent = 0;
  let failed = 0;

  for (const channelId of channels) {
    let content = message;
    if (repeatBypass) {
      const rand = Math.floor(Math.random() * 1e15).toString();
      content = `${message}\n${rand}`;
    }

    try {
      const response = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content }),
        },
      );

      if (response.ok) {
        sent++;
        results.push({ channelId, success: true });
      } else {
        const errData = (await response.json()) as { message?: string };
        failed++;
        results.push({
          channelId,
          success: false,
          error: errData.message ?? `HTTP ${response.status}`,
        });
      }
    } catch (err) {
      failed++;
      results.push({ channelId, success: false, error: "Network error" });
    }
  }

  res.json({ sent, failed, results });
});

router.get("/sessions", async (req, res) => {
  const rows = await db.select().from(sessionsTable).orderBy(sessionsTable.createdAt);
  res.json(
    rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

router.post("/sessions", async (req, res) => {
  const parsed = CreateSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const [row] = await db
    .insert(sessionsTable)
    .values({
      name: parsed.data.name,
      token: parsed.data.token,
      channels: parsed.data.channels,
      message: parsed.data.message,
      delay: parsed.data.delay,
      repeatBypass: parsed.data.repeatBypass ?? false,
    })
    .returning();

  res.status(201).json({ ...row, createdAt: row.createdAt.toISOString() });
});

router.delete("/sessions/:id", async (req, res) => {
  const parsed = DeleteSessionParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ success: false });
    return;
  }

  await db.delete(sessionsTable).where(eq(sessionsTable.id, parsed.data.id));
  res.json({ success: true });
});

export default router;
