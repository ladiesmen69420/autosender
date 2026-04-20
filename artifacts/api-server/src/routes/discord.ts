import { Router } from "express";
import { db } from "@workspace/db";
import { sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  ValidateTokenBody,
  SendMessagesBody,
  CreateSessionBody,
  DeleteSessionParams,
  FetchDMsBody,
  GenerateAIReplyBody,
  RunAutoReplyBody,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";

const router = Router();

function makeHumanizedPrompt(persona?: string): string {
  const variants = [
    "Use a casual, human rhythm with small imperfections when natural.",
    "Sound like a real person typing a quick Discord DM, not an assistant.",
    "Keep it relaxed, specific to the message, and avoid polished marketing language.",
  ];
  const style = variants[Math.floor(Math.random() * variants.length)];
  return persona
    ? `You are a Discord user replying to a direct message. ${persona}. ${style} Write 1-2 short sentences. Do not announce that you are AI. Avoid markdown, hashtags, sign-offs, and robotic phrases like "I understand" unless they truly fit.`
    : `You are a Discord user replying to a direct message. ${style} Match the sender's tone. Write 1-2 short sentences. Do not announce that you are AI. Avoid markdown, hashtags, sign-offs, and robotic phrases like "I understand" unless they truly fit.`;
}

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

  const { token, channels, message } = parsed.data;
  const results: Array<{ channelId: string; success: boolean; error?: string }> = [];
  let sent = 0;
  let failed = 0;

  for (const channelId of channels) {
    const content = message;

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

router.post("/dms", async (req, res) => {
  const parsed = FetchDMsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json([]);
    return;
  }

  const { token } = parsed.data;

  try {
    // Get the current user's ID
    const meRes = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: token },
    });
    if (!meRes.ok) {
      res.status(401).json([]);
      return;
    }
    const me = (await meRes.json()) as { id: string };

    // Get DM channels
    const channelsRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
      headers: { Authorization: token },
    });
    if (!channelsRes.ok) {
      res.status(400).json([]);
      return;
    }

    const channels = (await channelsRes.json()) as Array<{
      id: string;
      type: number;
      recipients?: Array<{ id: string; username: string; avatar: string | null }>;
    }>;

    const dms = [];

    for (const channel of channels.filter((c) => c.type === 1).slice(0, 20)) {
      try {
        const msgsRes = await fetch(
          `https://discord.com/api/v10/channels/${channel.id}/messages?limit=1`,
          { headers: { Authorization: token } },
        );
        if (!msgsRes.ok) continue;

        const msgs = (await msgsRes.json()) as Array<{
          id: string;
          content: string;
          author: { id: string };
        }>;

        if (msgs.length === 0) continue;

        const lastMsg = msgs[0];
        const recipient = channel.recipients?.[0];
        if (!recipient) continue;

        dms.push({
          channelId: channel.id,
          userId: recipient.id,
          username: recipient.username,
          avatar: recipient.avatar,
          lastMessage: lastMsg.content,
          lastMessageId: lastMsg.id,
          fromMe: lastMsg.author.id === me.id,
        });
      } catch {
        // Skip errored channels
      }
    }

    res.json(dms);
  } catch (err) {
    req.log.error({ err }, "Error fetching DMs");
    res.status(500).json([]);
  }
});

router.post("/ai-reply", async (req, res) => {
  const parsed = GenerateAIReplyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ reply: "", sent: false });
    return;
  }

  const { context, persona, token, channelId } = parsed.data;

  try {
    const systemPrompt = makeHumanizedPrompt(persona);

    const completion = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 200,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Reply naturally to this Discord DM. Message/context: "${context}"` },
      ],
    });

    const reply = completion.choices[0]?.message?.content?.trim() ?? "";

    let sent = false;
    if (token && channelId && reply) {
      try {
        const sendRes = await fetch(
          `https://discord.com/api/v10/channels/${channelId}/messages`,
          {
            method: "POST",
            headers: { Authorization: token, "Content-Type": "application/json" },
            body: JSON.stringify({ content: reply }),
          },
        );
        sent = sendRes.ok;
      } catch {
        sent = false;
      }
    }

    res.json({ reply, sent });
  } catch (err) {
    req.log.error({ err }, "AI reply generation error");
    res.status(500).json({ reply: "", sent: false });
  }
});

router.post("/auto-reply", async (req, res) => {
  const parsed = RunAutoReplyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ replied: 0, skipped: 0, details: [] });
    return;
  }

  const { token, persona, fixedMessage } = parsed.data;

  try {
    // Get current user
    const meRes = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: token },
    });
    if (!meRes.ok) {
      res.status(401).json({ replied: 0, skipped: 0, details: [] });
      return;
    }
    const me = (await meRes.json()) as { id: string };

    // Get DM channels
    const channelsRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
      headers: { Authorization: token },
    });
    if (!channelsRes.ok) {
      res.status(400).json({ replied: 0, skipped: 0, details: [] });
      return;
    }

    const channels = (await channelsRes.json()) as Array<{
      id: string;
      type: number;
      recipients?: Array<{ id: string; username: string; avatar: string | null }>;
    }>;

    const systemPrompt = makeHumanizedPrompt(persona);

    const details: Array<{ username: string; channelId: string; reply: string; success: boolean }> = [];
    let replied = 0;
    let skipped = 0;

    for (const channel of channels.filter((c) => c.type === 1).slice(0, 10)) {
      try {
        const msgsRes = await fetch(
          `https://discord.com/api/v10/channels/${channel.id}/messages?limit=1`,
          { headers: { Authorization: token } },
        );
        if (!msgsRes.ok) { skipped++; continue; }

        const msgs = (await msgsRes.json()) as Array<{
          id: string;
          content: string;
          author: { id: string };
        }>;

        if (msgs.length === 0 || msgs[0].author.id === me.id) {
          skipped++;
          continue;
        }

        const lastMsg = msgs[0];
        const recipient = channel.recipients?.[0];

        let reply = fixedMessage?.trim() ?? "";
        if (!reply) {
          const completion = await openai.chat.completions.create({
            model: "gpt-5.2",
            max_completion_tokens: 200,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: `Reply naturally to this Discord DM. Message/context: "${lastMsg.content}"` },
            ],
          });

          reply = completion.choices[0]?.message?.content?.trim() ?? "";
        }

        if (!reply) {
          skipped++;
          continue;
        }

        // Send the reply
        const sendRes = await fetch(
          `https://discord.com/api/v10/channels/${channel.id}/messages`,
          {
            method: "POST",
            headers: { Authorization: token, "Content-Type": "application/json" },
            body: JSON.stringify({ content: reply }),
          },
        );

        const success = sendRes.ok;
        if (success) replied++;
        else skipped++;

        details.push({
          username: recipient?.username ?? "Unknown",
          channelId: channel.id,
          reply,
          success,
        });
      } catch {
        skipped++;
      }
    }

    res.json({ replied, skipped, details });
  } catch (err) {
    req.log.error({ err }, "Auto-reply error");
    res.status(500).json({ replied: 0, skipped: 0, details: [] });
  }
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
      jitter: parsed.data.jitter ?? 0,
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
