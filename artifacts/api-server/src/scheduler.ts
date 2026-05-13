import { db, campaignsTable, campaignLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";
import { discordHeaders, pickStableUA } from "./lib/discord-headers";

const MAX_CONSECUTIVE_FAILURES = 5;

/* ─── Rotation state ─────────────────────────────────────────────────────── */
// All running campaigns share one rotation queue. The scheduler fires them
// one at a time in order, cycling through indefinitely.
const rotationQueue: number[] = [];   // campaign IDs in rotation order
let rotationCursor = 0;               // next index to fire
let rotationActive = false;
let rotationTimer: ReturnType<typeof setTimeout> | null = null;
const nextRunAt = new Map<number, number>();

// Per-campaign bookkeeping for stats / UI
const sendCounts    = new Map<number, number>();
const nextSendTimes = new Map<number, Date>();

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function pickUA(token: string): string {
  return pickStableUA(token);
}

function humanDelay(min = 400, max = 2200): Promise<void> {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

function getStatusInfo(status: number): { message: string; suggestion: string } {
  if (status === 401) return {
    message: "Invalid or expired token",
    suggestion: "Your Discord token is invalid or has expired. Go to Tokens page to get a fresh token.",
  };
  if (status === 403) return {
    message: "Missing channel permissions",
    suggestion: "Your account doesn't have permission to send messages in this channel. Check channel permissions or remove this channel ID.",
  };
  if (status === 404) return {
    message: "Channel not found",
    suggestion: "The channel ID is incorrect or the channel was deleted. Verify and update your channel list.",
  };
  if (status === 429) return {
    message: "Rate limited by Discord",
    suggestion: "You're sending too fast. Enable Rate Limit Protection or increase your sending interval.",
  };
  if (status >= 500) return {
    message: `Discord server error (${status})`,
    suggestion: "This is a temporary Discord issue. The campaign will retry automatically.",
  };
  return {
    message: `HTTP ${status} error`,
    suggestion: "Unexpected error. Check your token and channel IDs. The campaign will retry.",
  };
}

async function writeLog(
  campaignId: number,
  type: "success" | "warning" | "error",
  message: string,
  channelId?: string,
  details?: string,
  suggestion?: string,
) {
  try {
    await db.insert(campaignLogsTable).values({
      campaignId,
      type,
      message,
      channelId: channelId ?? null,
      details: details ?? null,
      suggestion: suggestion ?? null,
    });
  } catch (err) {
    logger.error({ err }, "Failed to write campaign log");
  }
}

export async function doSend(
  token: string,
  channelId: string,
  message: string,
  ua: string,
): Promise<{ ok: boolean; status: number; retryAfterMs: number }> {
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: discordHeaders(token, { ua }),
    body: JSON.stringify({ content: message }),
  });

  let retryAfterMs = 0;
  if (res.status === 429) {
    try {
      const data = (await res.json()) as { retry_after?: number };
      retryAfterMs = Math.ceil((data.retry_after ?? 1) * 1000);
    } catch {
      retryAfterMs = 5000;
    }
  } else {
    try { await res.text(); } catch {}
  }

  return { ok: res.ok, status: res.status, retryAfterMs };
}

/* ─── Send window helpers ────────────────────────────────────────────────── */
function parseHHMM(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function isWithinSendWindow(start: string | null | undefined, end: string | null | undefined): boolean {
  const startMin = parseHHMM(start);
  const endMin   = parseHHMM(end);
  if (startMin === null || endMin === null) return true; // no window = always active
  const now        = new Date();
  const currentMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (startMin <= endMin) return currentMin >= startMin && currentMin < endMin;
  // wraps midnight: e.g. 22:00 → 06:00
  return currentMin >= startMin || currentMin < endMin;
}

function minutesUntilWindowOpen(start: string | null | undefined): number {
  const startMin = parseHHMM(start);
  if (startMin === null) return 0;
  const now        = new Date();
  const currentMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const diff       = startMin - currentMin;
  return diff > 0 ? diff : diff + 24 * 60;
}

/* ─── Core: execute one campaign send cycle ──────────────────────────────── */
/**
 * Fires one send cycle for the given campaign.
 * Returns the milliseconds to wait before triggering the NEXT rotation step,
 * and whether the campaign should be removed from the queue.
 */
async function executeCampaignCycle(id: number): Promise<{ nextMs: number; remove: boolean }> {
  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, id))
    .limit(1);

  if (!campaign || !campaign.running) {
    return { nextMs: 0, remove: true };
  }

  // Send window enforcement — skip this campaign, rotate quickly to the next
  if (!isWithinSendWindow(campaign.sendWindowStart, campaign.sendWindowEnd)) {
    const waitMins = minutesUntilWindowOpen(campaign.sendWindowStart);
    await writeLog(
      id,
      "warning",
      `Outside send window (${campaign.sendWindowStart}–${campaign.sendWindowEnd} UTC) — skipping this rotation`,
      undefined,
      `${waitMins} min until window opens`,
    );
    return { nextMs: 2000, remove: false };
  }

  const cycleCount = (sendCounts.get(id) ?? 0) + 1;
  sendCounts.set(id, cycleCount);

  let sent = 0;
  let failed = 0;
  let rateLimited = false;
  let retryAfterMs = 0;
  const ua = pickUA(campaign.token);

  for (let i = 0; i < campaign.channels.length; i++) {
    const channelId = campaign.channels[i];
    if (i > 0) await humanDelay(600, 2500);

    try {
      const result = await doSend(campaign.token, channelId, campaign.message, ua);

      if (result.status === 429) {
        rateLimited = true;
        retryAfterMs = Math.max(retryAfterMs, result.retryAfterMs);
        failed++;
        await writeLog(id, "warning", `Rate limited on channel ${channelId}`, channelId, "Discord returned 429 Too Many Requests", getStatusInfo(429).suggestion);
      } else if (result.ok) {
        sent++;
        await writeLog(id, "success", `Message sent to channel ${channelId}`, channelId);
      } else {
        failed++;
        const info = getStatusInfo(result.status);
        await writeLog(id, "error", info.message, channelId, `HTTP ${result.status} response from Discord API`, info.suggestion);
      }
    } catch (err) {
      failed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      await writeLog(id, "error", `Network error sending to ${channelId}`, channelId, errMsg, "Check your server's internet connection.");
      logger.error({ err, campaignId: id, channelId }, "Network send error");
    }
  }

  // Rate limit protection
  let newRateLimitBonus = campaign.rateLimitBonus;
  if (campaign.rateLimitProtection) {
    if (rateLimited) {
      newRateLimitBonus = Math.min(campaign.rateLimitBonus + 10, 300);
      await writeLog(id, "warning", `Rate limit protection: +${newRateLimitBonus - campaign.rateLimitBonus}s delay added`, undefined, `New effective interval: ${campaign.delay + newRateLimitBonus}s`);
    } else if (cycleCount % 5 === 0 && campaign.rateLimitBonus > 0) {
      newRateLimitBonus = Math.max(campaign.rateLimitBonus - 2, 0);
    }
  } else {
    newRateLimitBonus = 0;
  }

  // Consecutive failure tracking / auto-stop
  const allFailed = sent === 0 && failed > 0;
  const newConsecutiveFailures = allFailed ? campaign.consecutiveFailures + 1 : 0;

  if (newConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    await writeLog(
      id, "error",
      `Campaign auto-stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
      undefined,
      `All sends have failed ${MAX_CONSECUTIVE_FAILURES} times in a row.`,
      "Check your Discord token (may be invalid/expired), channel IDs, and permissions.",
    );
    await db
      .update(campaignsTable)
      .set({
        running: false,
        sentCount: campaign.sentCount + sent,
        failedCount: campaign.failedCount + failed,
        rateLimitBonus: newRateLimitBonus,
        consecutiveFailures: newConsecutiveFailures,
        lastSentAt: new Date(),
      })
      .where(eq(campaignsTable.id, id));
    logger.warn({ campaignId: id }, "Campaign auto-stopped due to consecutive failures");
    return { nextMs: 0, remove: true };
  }

  await db
    .update(campaignsTable)
    .set({
      sentCount: campaign.sentCount + sent,
      failedCount: campaign.failedCount + failed,
      rateLimitBonus: newRateLimitBonus,
      consecutiveFailures: newConsecutiveFailures,
      lastSentAt: new Date(),
    })
    .where(eq(campaignsTable.id, id));

  // Verify still running after DB write
  const [fresh] = await db
    .select({ running: campaignsTable.running })
    .from(campaignsTable)
    .where(eq(campaignsTable.id, id))
    .limit(1);

  if (!fresh?.running) return { nextMs: 0, remove: true };

  // Compute delay until the next rotation step fires
  let nextMs = (campaign.delay + newRateLimitBonus) * 1000;
  if (campaign.jitter > 0) {
    nextMs += (campaign.delay * 1000 * Math.random() * campaign.jitter) / 100;
  }
  if (rateLimited && retryAfterMs > 0) {
    nextMs = Math.max(nextMs, retryAfterMs + 2000);
  }

  // Burst break every 15 cycles
  if (cycleCount % 15 === 0) {
    const burstBreakMs = 30000 + Math.random() * 60000;
    nextMs += burstBreakMs;
    await writeLog(id, "warning", `Burst break applied: +${Math.round(burstBreakMs / 1000)}s pause`, undefined, "Every 15 cycles a random pause is added to mimic human behavior.");
    logger.info({ campaignId: id }, "Burst break applied");
  }

  return { nextMs, remove: false };
}

function scheduleNextRotationStep(delayMs: number): void {
  if (rotationTimer) clearTimeout(rotationTimer);
  rotationTimer = setTimeout(runRotationStep, Math.max(0, delayMs));
}

/* ─── Rotation loop ──────────────────────────────────────────────────────── */
async function runRotationStep(): Promise<void> {
  if (rotationQueue.length === 0) {
    rotationActive = false;
    rotationTimer  = null;
    return;
  }

  rotationActive = true;

  // Pick next campaign in the queue
  if (rotationCursor >= rotationQueue.length) rotationCursor = 0;
  const id = rotationQueue[rotationCursor];
  rotationCursor = (rotationCursor + 1) % rotationQueue.length;

  const { nextMs, remove } = await executeCampaignCycle(id);

  if (remove) {
    const idx = rotationQueue.indexOf(id);
    if (idx !== -1) {
      rotationQueue.splice(idx, 1);
      if (rotationCursor > idx) rotationCursor = Math.max(0, rotationCursor - 1);
      if (rotationCursor >= rotationQueue.length) rotationCursor = 0;
    }
    sendCounts.delete(id);
    nextSendTimes.delete(id);
    nextRunAt.delete(id);

    if (rotationQueue.length === 0) {
      rotationActive = false;
      rotationTimer  = null;
      return;
    }
    // Continue quickly to next campaign
    rotationTimer = setTimeout(runRotationStep, 500);
    return;
  }

  const now = Date.now();
  const targetAt = nextRunAt.get(id) ?? now + nextMs;
  nextRunAt.set(id, targetAt + nextMs);
  nextSendTimes.set(id, new Date(targetAt));
  scheduleNextRotationStep(Math.max(0, targetAt - now));
}

/* ─── Public API ─────────────────────────────────────────────────────────── */
export function startCampaignSchedule(id: number): void {
  if (!rotationQueue.includes(id)) {
    rotationQueue.push(id);
    nextRunAt.set(id, Date.now());
    logger.info({ campaignId: id, queueLength: rotationQueue.length }, "Campaign added to rotation");
  }
  if (!rotationActive) {
    runRotationStep();
  }
}

export function stopCampaignSchedule(id: number): void {
  const idx = rotationQueue.indexOf(id);
  if (idx !== -1) {
    rotationQueue.splice(idx, 1);
    if (rotationCursor > idx) rotationCursor = Math.max(0, rotationCursor - 1);
    if (rotationCursor >= rotationQueue.length) rotationCursor = 0;
    logger.info({ campaignId: id, queueLength: rotationQueue.length }, "Campaign removed from rotation");
  }
  sendCounts.delete(id);
  nextSendTimes.delete(id);
  nextRunAt.delete(id);

  // If queue is now empty, cancel the timer
  if (rotationQueue.length === 0 && rotationTimer) {
    clearTimeout(rotationTimer);
    rotationTimer  = null;
    rotationActive = false;
  }
}

export function isRunning(id: number): boolean {
  return rotationQueue.includes(id);
}

export function getNextSendAt(id: number): Date | null {
  return nextSendTimes.get(id) ?? null;
}

export async function initScheduler(): Promise<void> {
  const running = await db
    .select({ id: campaignsTable.id })
    .from(campaignsTable)
    .where(eq(campaignsTable.running, true));

  for (const { id } of running) {
    startCampaignSchedule(id);
  }

  logger.info({ count: running.length }, "Scheduler initialized");
}

export async function syncRotationCampaigns(): Promise<void> {
  const rows = await db
    .select({ id: campaignsTable.id, running: campaignsTable.running, rotateEnabled: campaignsTable.rotateEnabled })
    .from(campaignsTable);
  for (const row of rows) {
    if (row.running && row.rotateEnabled) startCampaignSchedule(row.id);
    else stopCampaignSchedule(row.id);
  }
}
