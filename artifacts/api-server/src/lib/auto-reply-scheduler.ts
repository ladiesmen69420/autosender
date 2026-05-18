import { db, autoReplySessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { discordHeaders } from "./discord-headers";
import { discordFetch } from "./discord-fetch";
import { openai } from "@workspace/integrations-openai-ai-server";

const AI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

// Per-user in-memory state
type SessionState = {
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
  scansCompleted: number;
  repliesSent: number;
  lastScanAt: number | null;
  startedAt: number;
  sentCountsByChannel: Record<string, number>;
  lastError: string | null;
  aiFailures: number;
};

const sessions = new Map<string, SessionState>();

// ── Discord helpers ──────────────────────────────────────────────────────────

const ZW_CHARS = ["\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF"];
function obfuscate(message: string): string {
  const count = 1 + Math.floor(Math.random() * 4);
  let salt = "";
  for (let i = 0; i < count; i++) salt += ZW_CHARS[Math.floor(Math.random() * ZW_CHARS.length)];
  if (Math.random() < 0.25 && message.includes(" ")) {
    const idx = message.lastIndexOf(" ");
    return message.slice(0, idx) + salt + message.slice(idx);
  }
  return message + salt;
}

function cancellableDelay(ms: number, state: SessionState): Promise<void> {
  return new Promise((resolve) => {
    const interval = 200;
    let elapsed = 0;
    const tick = () => {
      if (state.cancelled || elapsed >= ms) { resolve(); return; }
      elapsed += interval;
      setTimeout(tick, Math.min(interval, ms - elapsed + interval));
    };
    setTimeout(tick, Math.min(interval, ms));
  });
}

function jitter(min: number, max: number, state: SessionState): Promise<void> {
  return cancellableDelay(min + Math.random() * (max - min), state);
}

async function ackMessage(token: string, channelId: string, messageId: string): Promise<void> {
  try {
    await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/ack`, {
      method: "POST",
      headers: discordHeaders(token),
      body: JSON.stringify({ token: null, manual: false }),
    });
  } catch {}
}

async function sendTyping(token: string, channelId: string): Promise<void> {
  try {
    await discordFetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
      method: "POST",
      headers: discordHeaders(token),
    });
  } catch {}
}

async function humanComposeDelay(token: string, channelId: string, text: string, state: SessionState): Promise<void> {
  await cancellableDelay(1200 + Math.random() * 1800, state);
  if (state.cancelled) return;
  await sendTyping(token, channelId);
  const perChar = 45 + Math.random() * 45;
  const typingMs = Math.min(35000, text.length * perChar + 800 + Math.random() * 1500);
  let elapsed = 0;
  while (elapsed < typingMs) {
    if (state.cancelled) return;
    const slice = Math.min(8000, typingMs - elapsed);
    await cancellableDelay(slice, state);
    elapsed += slice;
    if (elapsed < typingMs && !state.cancelled) await sendTyping(token, channelId);
  }
}

async function warmupChannel(token: string, channelId: string): Promise<void> {
  try {
    await discordFetch(`https://discord.com/api/v10/channels/${channelId}`, {
      method: "GET",
      headers: discordHeaders(token, { contentType: false }),
    });
  } catch {}
  await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
  try {
    await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=50`, {
      method: "GET",
      headers: discordHeaders(token, { contentType: false }),
    });
  } catch {}
}

async function fetchMessageRequests(token: string): Promise<Array<{ id: string; type: number; recipients?: Array<{ id: string; username: string }> }>> {
  try {
    const r = await discordFetch("https://discord.com/api/v10/users/@me/message-requests", {
      headers: discordHeaders(token, { contentType: false }),
    });
    if (!r.ok) return [];
    const data = await r.json() as Array<{ id: string; type: number; recipients?: Array<{ id: string; username: string }> }>;
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function makePrompt(persona?: string): string {
  const style = "Sound like a real person typing a quick Discord DM, not an assistant. Keep it relaxed.";
  const safety = "Never include any URL, link, invite code, phone number, email address, or external contact. Never use markdown.";
  return persona
    ? `You are a Discord user replying to a direct message. ${persona}. ${style} Write 1-2 short sentences. ${safety}`
    : `You are a Discord user replying to a direct message. ${style} Match the sender's tone. Write 1-2 short sentences. ${safety}`;
}

// Active hours check using SGT (UTC+8) consistently
function isActiveHourSGT(start: number, end: number): boolean {
  const now = new Date();
  const sgtHour = (now.getUTCHours() + 8) % 24;
  if (start === end) return true;
  if (start < end) return sgtHour >= start && sgtHour < end;
  return sgtHour >= start || sgtHour < end;
}

// ── Core scan ────────────────────────────────────────────────────────────────

async function runScan(userId: string, state: SessionState): Promise<void> {
  if (state.running) return;
  state.running = true;

  const [row] = await db.select().from(autoReplySessionsTable).where(eq(autoReplySessionsTable.userId, userId)).limit(1);
  if (!row || !row.enabled || !row.token) {
    state.running = false;
    return;
  }

  if (!isActiveHourSGT(row.activeHoursStart, row.activeHoursEnd)) {
    state.running = false;
    return;
  }

  const { token, persona, fixedMessage, triggerKeywords, maxRepliesPerUser, maxRepliesPerCycle } = row;
  const useFixed = fixedMessage.trim().length > 0;
  const triggers = triggerKeywords.split(",").map((s: string) => s.trim()).filter(Boolean);
  const cycleCap = maxRepliesPerCycle > 0 ? maxRepliesPerCycle : 2;
  const perUserCap = maxRepliesPerUser > 0 ? maxRepliesPerUser : Infinity;

  try {
    const meRes = await discordFetch("https://discord.com/api/v10/users/@me", {
      headers: discordHeaders(token, { contentType: false }),
    });
    if (!meRes.ok) {
      state.lastError = `Token validation failed (HTTP ${meRes.status})`;
      state.running = false;
      return;
    }
    const me = await meRes.json() as { id: string };

    const chRes = await discordFetch("https://discord.com/api/v10/users/@me/channels", {
      headers: discordHeaders(token, { contentType: false }),
    });
    if (!chRes.ok) {
      state.lastError = `Failed to fetch DM list (HTTP ${chRes.status})`;
      state.running = false;
      return;
    }
    const openChannels = await chRes.json() as Array<{ id: string; type: number; recipients?: Array<{ id: string; username: string }> }>;
    const requestChannels = await fetchMessageRequests(token);
    const seen = new Set(openChannels.map((c) => c.id));
    const channels = [
      ...openChannels.filter((c) => c.type === 1),
      ...requestChannels.filter((c) => c.type === 1 && !seen.has(c.id)),
    ];

    const ordered = [...channels.slice(0, 15)].sort(() => Math.random() - 0.5);
    let replied = 0;

    for (const ch of ordered) {
      if (state.cancelled) break;
      if (replied >= cycleCap) break;
      if ((state.sentCountsByChannel[ch.id] ?? 0) >= perUserCap) continue;

      if (ordered.indexOf(ch) > 0) await jitter(1500, 4500, state);
      if (state.cancelled) break;

      const msgsRes = await discordFetch(`https://discord.com/api/v10/channels/${ch.id}/messages?limit=1`, {
        headers: discordHeaders(token, { contentType: false }),
      });
      if (!msgsRes.ok) {
        logger.warn({ channelId: ch.id, status: msgsRes.status }, "auto-reply-scheduler: failed to fetch messages for channel");
        continue;
      }
      const msgs = await msgsRes.json() as Array<{ id: string; content: string; author: { id: string } }>;
      if (!msgs.length || msgs[0].author.id === me.id) continue;

      const lastMsg = msgs[0];

      if (triggers.length > 0) {
        const hay = (lastMsg.content ?? "").toLowerCase();
        if (!triggers.some((kw: string) => hay.includes(kw))) continue;
      }

      const fixed = useFixed ? fixedMessage.trim() : "";
      let reply = fixed ? obfuscate(fixed) : "";

      if (!reply) {
        try {
          const completion = await openai.chat.completions.create({
            model: AI_MODEL,
            max_completion_tokens: 200,
            messages: [
              { role: "system", content: makePrompt(persona || undefined) },
              { role: "user", content: `Reply to: "${lastMsg.content}"` },
            ],
          });
          reply = completion.choices[0]?.message?.content?.trim() ?? "";
        } catch (aiErr) {
          const aiMsg = aiErr instanceof Error ? aiErr.message : String(aiErr);
          state.aiFailures++;
          state.lastError = `AI generation failed: ${aiMsg}`;
          logger.error({ err: aiMsg, channelId: ch.id }, "auto-reply-scheduler: OpenAI error");
          continue;
        }
      }
      if (!reply) continue;

      if (state.cancelled) break;

      await warmupChannel(token, ch.id);
      await ackMessage(token, ch.id, lastMsg.id);
      await humanComposeDelay(token, ch.id, reply, state);

      if (state.cancelled) break;

      const sendRes = await discordFetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
        method: "POST",
        headers: discordHeaders(token),
        body: JSON.stringify({ content: reply }),
      });

      if (sendRes.ok) {
        replied++;
        state.repliesSent++;
        state.sentCountsByChannel[ch.id] = (state.sentCountsByChannel[ch.id] ?? 0) + 1;
        state.lastError = null;
      } else {
        let errBody = "";
        try {
          const errText = await sendRes.text();
          try { errBody = JSON.parse(errText)?.message ?? errText; } catch { errBody = errText; }
        } catch {}
        const sendErrMsg = `Send to ${ch.id} failed (HTTP ${sendRes.status}): ${errBody.slice(0, 200)}`;
        state.lastError = sendErrMsg;
        logger.warn({ channelId: ch.id, status: sendRes.status, body: errBody.slice(0, 200) }, "auto-reply-scheduler: send failed");
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.lastError = `Scan error: ${msg}`;
    logger.warn({ err: msg }, "auto-reply-scheduler: scan error");
  }

  state.scansCompleted++;
  state.lastScanAt = Date.now();

  try {
    await db.update(autoReplySessionsTable)
      .set({ sentCountsByChannel: JSON.stringify(state.sentCountsByChannel) })
      .where(eq(autoReplySessionsTable.userId, userId));
  } catch {}

  state.running = false;
}

// ── Loop scheduling ──────────────────────────────────────────────────────────

function scheduleNext(userId: string, state: SessionState): void {
  if (state.cancelled) return;
  const longBreak = Math.random() < 0.15;
  const delay = longBreak
    ? 240000 + Math.random() * 240000
    : 75000 + Math.random() * 105000;
  state.timer = setTimeout(async () => {
    if (state.cancelled) return;
    await runScan(userId, state);
    if (!state.cancelled) scheduleNext(userId, state);
  }, delay);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function startAutoReplySession(userId: string, sentCounts: Record<string, number> = {}): void {
  stopAutoReplySession(userId);

  const state: SessionState = {
    running: false,
    timer: null,
    cancelled: false,
    scansCompleted: 0,
    repliesSent: 0,
    lastScanAt: null,
    startedAt: Date.now(),
    sentCountsByChannel: { ...sentCounts },
    lastError: null,
    aiFailures: 0,
  };
  sessions.set(userId, state);

  state.timer = setTimeout(async () => {
    if (state.cancelled) return;
    await runScan(userId, state);
    if (!state.cancelled) scheduleNext(userId, state);
  }, 3000 + Math.random() * 5000);

  logger.info({ userId }, "auto-reply-scheduler: session started");
}

export function stopAutoReplySession(userId: string): void {
  const state = sessions.get(userId);
  if (!state) return;
  state.cancelled = true;
  if (state.timer) clearTimeout(state.timer);
  sessions.delete(userId);
  logger.info({ userId }, "auto-reply-scheduler: session stopped");
}

export function getAutoReplySessionStatus(userId: string): {
  active: boolean;
  scansCompleted: number;
  repliesSent: number;
  lastScanAt: number | null;
  uptimeMs: number;
  sentCountsByChannel: Record<string, number>;
  lastError: string | null;
  aiFailures: number;
} {
  const state = sessions.get(userId);
  if (!state) return { active: false, scansCompleted: 0, repliesSent: 0, lastScanAt: null, uptimeMs: 0, sentCountsByChannel: {}, lastError: null, aiFailures: 0 };
  return {
    active: true,
    scansCompleted: state.scansCompleted,
    repliesSent: state.repliesSent,
    lastScanAt: state.lastScanAt,
    uptimeMs: Date.now() - state.startedAt,
    sentCountsByChannel: state.sentCountsByChannel,
    lastError: state.lastError,
    aiFailures: state.aiFailures,
  };
}

export async function initAutoReplyScheduler(): Promise<void> {
  try {
    const rows = await db.select().from(autoReplySessionsTable).where(eq(autoReplySessionsTable.enabled, true));
    for (const row of rows) {
      let sentCounts: Record<string, number> = {};
      try { sentCounts = JSON.parse(row.sentCountsByChannel); } catch {}
      startAutoReplySession(row.userId, sentCounts);
    }
    logger.info({ count: rows.length }, "auto-reply-scheduler: initialized");
  } catch (err) {
    logger.error({ err: (err as Error)?.message }, "auto-reply-scheduler: init failed");
  }
}
