import { db, campaignsTable, campaignLogsTable } from "@workspace/db";
import { eq, and, gte } from "drizzle-orm";
import { logger } from "./lib/logger";
import { discordHeaders, pickStableUA } from "./lib/discord-headers";

const MAX_CONSECUTIVE_FAILURES = 5;

const timers = new Map<number, ReturnType<typeof setTimeout>>();
const sendCounts = new Map<number, number>();
const nextSendTimes = new Map<number, Date>();

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

async function sendCampaign(id: number): Promise<void> {
  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, id))
    .limit(1);

  if (!campaign || !campaign.running) {
    timers.delete(id);
    sendCounts.delete(id);
    nextSendTimes.delete(id);
    return;
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
        const info = getStatusInfo(429);
        await writeLog(id, "warning", `Rate limited on channel ${channelId}`, channelId, "Discord returned 429 Too Many Requests", info.suggestion);
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
      await writeLog(id, "error", `Network error sending to ${channelId}`, channelId, errMsg, "Check your server's internet connection. The campaign will retry automatically.");
      logger.error({ err, campaignId: id, channelId }, "Network send error");
    }
  }

  let newRateLimitBonus = campaign.rateLimitBonus;
  if (campaign.rateLimitProtection) {
    if (rateLimited) {
      newRateLimitBonus = Math.min(campaign.rateLimitBonus + 10, 300);
      await writeLog(id, "warning", `Rate limit protection applied: +${newRateLimitBonus - campaign.rateLimitBonus}s delay added`, undefined, `New effective interval: ${campaign.delay + newRateLimitBonus}s`, "This is automatic. Disable rate limit protection in campaign settings if you want manual control.");
    } else if (cycleCount % 5 === 0 && campaign.rateLimitBonus > 0) {
      newRateLimitBonus = Math.max(campaign.rateLimitBonus - 2, 0);
    }
  } else {
    newRateLimitBonus = 0;
  }

  // Track consecutive failures for auto-stop
  const allFailed = sent === 0 && failed > 0;
  const newConsecutiveFailures = allFailed
    ? campaign.consecutiveFailures + 1
    : 0;

  // Auto-stop if too many consecutive failures
  if (newConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    await writeLog(
      id,
      "error",
      `Campaign auto-stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
      undefined,
      `All sends have failed ${MAX_CONSECUTIVE_FAILURES} times in a row.`,
      "Check your Discord token (may be invalid/expired), channel IDs, and permissions. Update and restart the campaign.",
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
    timers.delete(id);
    sendCounts.delete(id);
    nextSendTimes.delete(id);
    logger.warn({ campaignId: id }, "Campaign auto-stopped due to consecutive failures");
    return;
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

  const [fresh] = await db
    .select({ running: campaignsTable.running })
    .from(campaignsTable)
    .where(eq(campaignsTable.id, id))
    .limit(1);

  if (!fresh?.running) {
    timers.delete(id);
    sendCounts.delete(id);
    nextSendTimes.delete(id);
    return;
  }

  let nextMs = (campaign.delay + newRateLimitBonus) * 1000;
  if (campaign.jitter > 0) {
    nextMs += (campaign.delay * 1000 * Math.random() * campaign.jitter) / 100;
  }
  if (rateLimited && retryAfterMs > 0) {
    nextMs = Math.max(nextMs, retryAfterMs + 2000);
  }
  if (cycleCount % 15 === 0) {
    const burstBreakMs = 30000 + Math.random() * 60000;
    nextMs += burstBreakMs;
    await writeLog(id, "warning", `Burst break applied: +${Math.round(burstBreakMs / 1000)}s pause`, undefined, "Every 15 cycles a random pause is added to mimic human behavior.", "This is normal anti-detection behavior.");
    logger.info({ campaignId: id }, "Burst break applied");
  }

  const nextAt = new Date(Date.now() + nextMs);
  nextSendTimes.set(id, nextAt);

  const timer = setTimeout(() => sendCampaign(id), nextMs);
  timers.set(id, timer);
}

export function startCampaignSchedule(id: number): void {
  if (timers.has(id)) return;
  sendCampaign(id);
  logger.info({ campaignId: id }, "Campaign schedule started");
}

export function stopCampaignSchedule(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  sendCounts.delete(id);
  nextSendTimes.delete(id);
  logger.info({ campaignId: id }, "Campaign schedule stopped");
}

export function isRunning(id: number): boolean {
  return timers.has(id);
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
