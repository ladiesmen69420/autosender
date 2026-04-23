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
import { discordHeaders } from "../lib/discord-headers";
import { discordFetch } from "../lib/discord-fetch";
import { startPresence, stopPresence, presenceStatus } from "../lib/discord-gateway";
import { startWarmup, stopWarmup, getWarmupState, isWarmupActive } from "../lib/discord-warmup";

function jitter(min: number, max: number): Promise<void> {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

// Send the typing indicator the way the official Discord client does before a
// human starts composing a reply. Official client refreshes typing every ~9s
// while the textbox is focused; we mirror this.
async function sendTyping(token: string, channelId: string): Promise<void> {
  try {
    await discordFetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
      method: "POST",
      headers: discordHeaders(token),
    });
  } catch {
    // typing failures are non-fatal
  }
}

// Mark the latest message as read — the official client always does this when
// the conversation has the focus before composing a reply. Skipping it is a
// strong "this is a selfbot" signal.
async function ackMessage(token: string, channelId: string, messageId: string): Promise<void> {
  try {
    await discordFetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/ack`,
      {
        method: "POST",
        headers: discordHeaders(token),
        body: JSON.stringify({ token: null, manual: false }),
      },
    );
  } catch {
    // ack failures are non-fatal
  }
}

// Mimic the official client's "user opened this DM" sequence. Discord's
// passive-risk detection looks for messages that appear without the normal
// preceding traffic (channel metadata fetch + recent history fetch + science
// telemetry). Hitting this sequence before sending makes the request stream
// indistinguishable from a real human opening the chat and replying.
async function warmupChannel(token: string, channelId: string): Promise<void> {
  try {
    await discordFetch(`https://discord.com/api/v10/channels/${channelId}`, {
      method: "GET",
      headers: discordHeaders(token, { contentType: false }),
    });
  } catch {
    // non-fatal
  }
  await jitter(150, 400);
  try {
    await discordFetch(
      `https://discord.com/api/v10/channels/${channelId}/messages?limit=50`,
      { method: "GET", headers: discordHeaders(token, { contentType: false }) },
    );
  } catch {
    // non-fatal
  }
  await jitter(120, 350);
  // Fire-and-forget science telemetry — official client sends this on chat open.
  try {
    const event = {
      events: [
        {
          type: "channel_opened",
          properties: { channel_id: channelId, channel_type: 1 },
        },
      ],
    };
    await discordFetch("https://discord.com/api/v10/science", {
      method: "POST",
      headers: discordHeaders(token),
      body: JSON.stringify(event),
    });
  } catch {
    // non-fatal
  }
}

// Detects URLs that are very likely to be flagged by Discord's external link
// intelligence: bare IPs, link shorteners (which hide the final domain), or
// suspiciously young / sketchy TLDs commonly used in scams. Used so we can
// warn callers before sending a message that contains them.
const SUSPICIOUS_SHORTENERS = new Set([
  "bit.ly", "tinyurl.com", "rebrand.ly", "shorturl.at", "rb.gy",
  "cutt.ly", "is.gd", "t.co", "tiny.cc", "ow.ly",
]);
const SUSPICIOUS_TLDS = new Set([
  "tk", "ml", "ga", "cf", "gq", "xyz", "top", "click", "country", "stream", "loan", "work", "rest", "buzz",
]);
function detectRiskyLinks(text: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/([^\s/)"']+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const host = m[1].toLowerCase();
    if (/^\d+\.\d+\.\d+\.\d+/.test(host)) { out.push(`Bare IP host (${host})`); continue; }
    if (SUSPICIOUS_SHORTENERS.has(host)) { out.push(`Link shortener (${host})`); continue; }
    const tld = host.split(".").pop() ?? "";
    if (SUSPICIOUS_TLDS.has(tld)) { out.push(`High-risk TLD .${tld} (${host})`); continue; }
  }
  return out;
}

// Simulate a human composing time scaled to the message length:
//   ~45-90ms per character of "thinking + typing" + a 1.2-3s "saw it" pause.
// While the human is "typing", refresh the typing indicator every 8s
// (Discord's typing TTL is 10s). Capped at 35s so we never block forever.
async function humanComposeDelay(token: string, channelId: string, replyText: string): Promise<void> {
  const lookPause = 1200 + Math.random() * 1800;
  await new Promise((r) => setTimeout(r, lookPause));

  await sendTyping(token, channelId);

  const perChar = 45 + Math.random() * 45;
  const typingMs = Math.min(35000, replyText.length * perChar + 800 + Math.random() * 1500);

  let elapsed = 0;
  const REFRESH = 8000;
  while (elapsed < typingMs) {
    const slice = Math.min(REFRESH, typingMs - elapsed);
    await new Promise((r) => setTimeout(r, slice));
    elapsed += slice;
    if (elapsed < typingMs) await sendTyping(token, channelId);
  }
}

// Build a per-send invisible-character salt that varies in both content and
// position. Discord's spam detection compares normalized message bodies across
// recent sends; rotating the variant defeats simple equality + edit-distance
// hashes without changing what the recipient sees.
function obfuscateFixed(message: string): string {
  const ZW_CHARS = ["\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF"];
  const count = 1 + Math.floor(Math.random() * 4);
  let salt = "";
  for (let i = 0; i < count; i++) {
    salt += ZW_CHARS[Math.floor(Math.random() * ZW_CHARS.length)];
  }
  // Splice the salt either at the end (most common) or just before the last word.
  if (Math.random() < 0.25 && message.includes(" ")) {
    const idx = message.lastIndexOf(" ");
    return message.slice(0, idx) + salt + message.slice(idx);
  }
  return message + salt;
}

type DiscordChannel = {
  id: string;
  type: number;
  recipients?: Array<{ id: string; username: string; avatar: string | null }>;
};

async function fetchMessageRequests(token: string): Promise<DiscordChannel[]> {
  // Discord exposes pending message requests at this endpoint for user accounts.
  // It may 404 on accounts without the feature; treat any failure as an empty list.
  try {
    const r = await discordFetch("https://discord.com/api/v10/users/@me/message-requests", {
      headers: discordHeaders(token, { contentType: false }),
    });
    if (!r.ok) return [];
    const data = (await r.json()) as DiscordChannel[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const router = Router();

function makeHumanizedPrompt(persona?: string): string {
  const variants = [
    "Use a casual, human rhythm with small imperfections when natural.",
    "Sound like a real person typing a quick Discord DM, not an assistant.",
    "Keep it relaxed, specific to the message, and avoid polished marketing language.",
  ];
  const style = variants[Math.floor(Math.random() * variants.length)];
  const safety = `Never include any URL, link, invite code, phone number, email address, crypto wallet address, or external contact handle. Never use markdown, hashtags, @everyone, @here, or sign-offs.`;
  return persona
    ? `You are a Discord user replying to a direct message. ${persona}. ${style} Write 1-2 short sentences. Do not announce that you are AI. ${safety} Avoid robotic phrases like "I understand" unless they truly fit.`
    : `You are a Discord user replying to a direct message. ${style} Match the sender's tone. Write 1-2 short sentences. Do not announce that you are AI. ${safety} Avoid robotic phrases like "I understand" unless they truly fit.`;
}

router.post("/validate-token", async (req, res) => {
  const parsed = ValidateTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ valid: false, error: "Invalid request body" });
    return;
  }

  const { token } = parsed.data;

  try {
    const response = await discordFetch("https://discord.com/api/v10/users/@me", {
      headers: discordHeaders(token, { contentType: false }),
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
      const response = await discordFetch(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: discordHeaders(token),
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
    const meRes = await discordFetch("https://discord.com/api/v10/users/@me", {
      headers: discordHeaders(token, { contentType: false }),
    });
    if (!meRes.ok) {
      res.status(401).json([]);
      return;
    }
    const me = (await meRes.json()) as { id: string };

    // Get DM channels (open conversations)
    const channelsRes = await discordFetch("https://discord.com/api/v10/users/@me/channels", {
      headers: discordHeaders(token, { contentType: false }),
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

    // Also fetch pending message requests (DMs from non-friends you haven't accepted)
    const requestChannels = await fetchMessageRequests(token);
    const seen = new Set(channels.map((c) => c.id));
    const allChannels = [
      ...channels.filter((c) => c.type === 1),
      ...requestChannels.filter((c) => c.type === 1 && !seen.has(c.id)),
    ];

    const dms = [];

    for (const channel of allChannels.slice(0, 30)) {
      try {
        const msgsRes = await discordFetch(
          `https://discord.com/api/v10/channels/${channel.id}/messages?limit=1`,
          { headers: discordHeaders(token, { contentType: false }) },
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
        const sendRes = await discordFetch(
          `https://discord.com/api/v10/channels/${channelId}/messages`,
          {
            method: "POST",
            headers: discordHeaders(token),
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

  const { token, persona, fixedMessage, triggerKeywords, maxRepliesPerUser, sentCountsByChannel, maxRepliesPerCycle } = parsed.data;
  const triggers = (triggerKeywords ?? [])
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
  const perUserCap = typeof maxRepliesPerUser === "number" && maxRepliesPerUser > 0 ? maxRepliesPerUser : Infinity;
  const sentCounts: Record<string, number> = sentCountsByChannel ?? {};
  const cycleCap = typeof maxRepliesPerCycle === "number" && maxRepliesPerCycle > 0 ? maxRepliesPerCycle : Infinity;

  try {
    // Get current user
    const meRes = await discordFetch("https://discord.com/api/v10/users/@me", {
      headers: discordHeaders(token, { contentType: false }),
    });
    if (!meRes.ok) {
      res.status(401).json({ replied: 0, skipped: 0, details: [] });
      return;
    }
    const me = (await meRes.json()) as { id: string };

    // Get DM channels
    const channelsRes = await discordFetch("https://discord.com/api/v10/users/@me/channels", {
      headers: discordHeaders(token, { contentType: false }),
    });
    if (!channelsRes.ok) {
      res.status(400).json({ replied: 0, skipped: 0, details: [] });
      return;
    }

    const openChannels = (await channelsRes.json()) as DiscordChannel[];
    const requestChannels = await fetchMessageRequests(token);
    const seenIds = new Set(openChannels.map((c) => c.id));
    const channels: DiscordChannel[] = [
      ...openChannels.filter((c) => c.type === 1),
      ...requestChannels.filter((c) => c.type === 1 && !seenIds.has(c.id)),
    ];

    const systemPrompt = makeHumanizedPrompt(persona);

    const details: Array<{ username: string; channelId: string; reply: string; success: boolean }> = [];
    let replied = 0;
    let skipped = 0;

    // Process channels in random order to avoid mechanical "always top first" patterns
    const ordered = [...channels.slice(0, 15)].sort(() => Math.random() - 0.5);

    for (const channel of ordered) {
      if (replied >= cycleCap) break;

      // Per-recipient cap: skip channels that have already received the max fixed replies
      if ((sentCounts[channel.id] ?? 0) >= perUserCap) {
        skipped++;
        continue;
      }
      try {
        // Random gap between checking conversations (mimics scrolling through DMs)
        if (ordered.indexOf(channel) > 0) await jitter(1500, 4500);

        const msgsRes = await discordFetch(
          `https://discord.com/api/v10/channels/${channel.id}/messages?limit=1`,
          { headers: discordHeaders(token, { contentType: false }) },
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

        // Trigger keyword filter
        if (triggers.length > 0) {
          const haystack = (lastMsg.content ?? "").toLowerCase();
          const matched = triggers.some((kw) => haystack.includes(kw));
          if (!matched) {
            skipped++;
            continue;
          }
        }
        const recipient = channel.recipients?.[0];

        const fixed = fixedMessage?.trim() ?? "";
        let reply = fixed ? obfuscateFixed(fixed) : "";
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

        // External link intelligence: warn loudly if the outgoing message
        // contains hosts that are known-bad signals (bare IPs, link
        // shorteners, sketchy TLDs). Discord weighs these heavily for
        // scam/phishing detection.
        const risky = detectRiskyLinks(reply);
        if (risky.length > 0) {
          req.log.warn({ channelId: channel.id, risky, replyPreview: reply.slice(0, 80) }, "Reply contains links Discord is likely to flag as scam/phishing — consider removing");
        }

        // Mimic the official client end-to-end: warm the channel (GET
        // metadata + recent history + science telemetry), mark as read, pause
        // like the user just glanced at the message, then show typing for a
        // duration proportional to the reply length.
        await warmupChannel(token, channel.id);
        await ackMessage(token, channel.id, lastMsg.id);
        await humanComposeDelay(token, channel.id, reply);

        // Send the reply
        const sendRes = await discordFetch(
          `https://discord.com/api/v10/channels/${channel.id}/messages`,
          {
            method: "POST",
            headers: discordHeaders(token),
            body: JSON.stringify({ content: reply }),
          },
        );

        const success = sendRes.ok;
        if (success) {
          replied++;
        } else {
          let errBody = "";
          try { errBody = await sendRes.text(); } catch {}
          req.log.warn({ channelId: channel.id, status: sendRes.status, body: errBody, replyPreview: reply.slice(0, 80) }, "Auto-reply send failed");
          skipped++;
        }

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
