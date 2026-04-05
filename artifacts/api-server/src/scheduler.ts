import { db, campaignsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0",
];

const timers = new Map<number, ReturnType<typeof setTimeout>>();
const sendCounts = new Map<number, number>(); // tracks burst cycles per campaign

function pickUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function humanDelay(min = 400, max = 2200): Promise<void> {
  const ms = min + Math.random() * (max - min);
  return new Promise((r) => setTimeout(r, ms));
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
    return;
  }

  const cycleCount = (sendCounts.get(id) ?? 0) + 1;
  sendCounts.set(id, cycleCount);

  let sent = 0;
  let failed = 0;
  let rateLimited = false;
  let retryAfterMs = 0;
  const ua = pickUA();

  for (let i = 0; i < campaign.channels.length; i++) {
    const channelId = campaign.channels[i];

    // Human-like delay between channels (skip first)
    if (i > 0) {
      await humanDelay(600, 2500);
    }

    try {
      const res = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: campaign.token,
            "Content-Type": "application/json",
            "User-Agent": ua,
            "X-Super-Properties": Buffer.from(
              JSON.stringify({ os: "Windows", browser: "Chrome", device: "" }),
            ).toString("base64"),
          },
          body: JSON.stringify({ content: campaign.message }),
        },
      );

      if (res.status === 429) {
        rateLimited = true;
        try {
          const data = (await res.json()) as { retry_after?: number };
          retryAfterMs = Math.max(retryAfterMs, Math.ceil((data.retry_after ?? 1) * 1000));
        } catch {
          retryAfterMs = Math.max(retryAfterMs, 5000);
        }
        failed++;
        logger.warn({ campaignId: id, channelId }, "Rate limited by Discord");
      } else if (res.ok) {
        sent++;
      } else {
        failed++;
        logger.warn({ campaignId: id, channelId, status: res.status }, "Send failed");
      }
    } catch (err) {
      failed++;
      logger.error({ err, campaignId: id, channelId }, "Send error");
    }
  }

  // Calculate adaptive rate limit bonus
  let newRateLimitBonus = campaign.rateLimitBonus;
  if (rateLimited) {
    newRateLimitBonus = Math.min(campaign.rateLimitBonus + 10, 300); // max 5min bonus
  } else if (cycleCount % 5 === 0 && campaign.rateLimitBonus > 0) {
    newRateLimitBonus = Math.max(campaign.rateLimitBonus - 2, 0); // slowly recover
  }

  // Persist updated counts + bonus
  await db
    .update(campaignsTable)
    .set({
      sentCount: campaign.sentCount + sent,
      failedCount: campaign.failedCount + failed,
      rateLimitBonus: newRateLimitBonus,
      lastSentAt: new Date(),
    })
    .where(eq(campaignsTable.id, id));

  // Check running state again before scheduling next
  const [fresh] = await db
    .select({ running: campaignsTable.running })
    .from(campaignsTable)
    .where(eq(campaignsTable.id, id))
    .limit(1);

  if (!fresh?.running) {
    timers.delete(id);
    sendCounts.delete(id);
    return;
  }

  // Compute next delay
  let nextMs = (campaign.delay + newRateLimitBonus) * 1000;

  // Apply jitter
  if (campaign.jitter > 0) {
    nextMs += (campaign.delay * 1000 * Math.random() * campaign.jitter) / 100;
  }

  // If rate limited, wait at least retry_after
  if (rateLimited && retryAfterMs > 0) {
    nextMs = Math.max(nextMs, retryAfterMs + 2000);
  }

  // Anti-detection burst break: every 15 cycles, add a longer pause (30–90s)
  if (cycleCount % 15 === 0) {
    nextMs += 30000 + Math.random() * 60000;
    logger.info({ campaignId: id }, "Burst break applied");
  }

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
  logger.info({ campaignId: id }, "Campaign schedule stopped");
}

export function isRunning(id: number): boolean {
  return timers.has(id);
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
