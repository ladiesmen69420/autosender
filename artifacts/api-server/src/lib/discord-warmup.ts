import { logger } from "./logger";
import { discordFetch } from "./discord-fetch";
import { discordHeaders } from "./discord-headers";

// Per-token warm-up state. While warm-up is active, the system performs
// purely passive activity (browse DMs, fetch messages, mark some as read,
// open guilds) on a randomized cadence — building up legitimate usage
// history for new tokens without sending anything. The send paths refuse
// to send while warm-up is active.

type WarmupState = {
  startedAt: number;
  endsAt: number;
  active: boolean;
  ticker: ReturnType<typeof setTimeout> | null;
  lastTickAt: number | null;
  ticksDone: number;
  channelsBrowsed: number;
  guildsOpened: number;
  messagesRead: number;
};

const WARMUPS = new Map<string, WarmupState>();
const DAY_MS = 24 * 60 * 60 * 1000;

export function isWarmupActive(token: string): boolean {
  const s = WARMUPS.get(token);
  if (!s || !s.active) return false;
  if (Date.now() >= s.endsAt) {
    s.active = false;
    if (s.ticker) clearTimeout(s.ticker);
    s.ticker = null;
    return false;
  }
  return true;
}

export function getWarmupState(token: string) {
  const s = WARMUPS.get(token);
  if (!s) {
    return {
      active: false,
      startedAt: 0,
      endsAt: 0,
      remainingMs: 0,
      ticksDone: 0,
      channelsBrowsed: 0,
      guildsOpened: 0,
      messagesRead: 0,
      lastTickAt: 0,
    };
  }
  const remainingMs = Math.max(0, s.endsAt - Date.now());
  return {
    active: s.active && remainingMs > 0,
    startedAt: s.startedAt,
    endsAt: s.endsAt,
    remainingMs,
    ticksDone: s.ticksDone,
    channelsBrowsed: s.channelsBrowsed,
    guildsOpened: s.guildsOpened,
    messagesRead: s.messagesRead,
    lastTickAt: s.lastTickAt ?? 0,
  };
}

async function jitter(min: number, max: number): Promise<void> {
  await new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

async function tick(token: string, s: WarmupState): Promise<void> {
  s.lastTickAt = Date.now();
  s.ticksDone++;
  const headers = discordHeaders(token, { contentType: false });

  try {
    // Mimic opening the app: hit a few baseline endpoints in a realistic order
    await discordFetch("https://discord.com/api/v10/users/@me", { method: "GET", headers });
    await jitter(300, 900);
    await discordFetch("https://discord.com/api/v10/users/@me/settings", { method: "GET", headers });
    await jitter(400, 1200);

    // Look at the guild list (showing as online + browsing servers)
    const gRes = await discordFetch("https://discord.com/api/v10/users/@me/guilds", { method: "GET", headers });
    let guilds: Array<{ id: string }> = [];
    if (gRes.ok) {
      try { guilds = (await gRes.json()) as Array<{ id: string }>; } catch {}
    }

    // Open up to 2 random guilds (but never write — we just fetch)
    const guildSample = [...guilds].sort(() => Math.random() - 0.5).slice(0, 2);
    for (const g of guildSample) {
      await jitter(800, 2500);
      try {
        await discordFetch(`https://discord.com/api/v10/guilds/${g.id}/channels`, { method: "GET", headers });
        s.guildsOpened++;
      } catch {}
    }

    // Browse the DM list
    await jitter(500, 1500);
    const dmRes = await discordFetch("https://discord.com/api/v10/users/@me/channels", { method: "GET", headers });
    let dms: Array<{ id: string; type: number }> = [];
    if (dmRes.ok) {
      try { dms = (await dmRes.json()) as Array<{ id: string; type: number }>; } catch {}
    }

    // Open 1-3 random DM threads (read-only)
    const dmSample = [...dms.filter((d) => d.type === 1 || d.type === 3)]
      .sort(() => Math.random() - 0.5)
      .slice(0, 1 + Math.floor(Math.random() * 3));

    for (const dm of dmSample) {
      await jitter(700, 2200);
      try {
        await discordFetch(`https://discord.com/api/v10/channels/${dm.id}`, { method: "GET", headers });
        await jitter(150, 400);
        const mRes = await discordFetch(
          `https://discord.com/api/v10/channels/${dm.id}/messages?limit=50`,
          { method: "GET", headers },
        );
        s.channelsBrowsed++;
        if (mRes.ok) {
          let msgs: Array<{ id: string; author: { id: string } }> = [];
          try { msgs = (await mRes.json()) as Array<{ id: string; author: { id: string } }>; } catch {}
          // Mark only ~50% as read — humans don't always read everything
          if (msgs.length > 0 && Math.random() < 0.5) {
            const last = msgs[0];
            try {
              await discordFetch(
                `https://discord.com/api/v10/channels/${dm.id}/messages/${last.id}/ack`,
                {
                  method: "POST",
                  headers: discordHeaders(token),
                  body: JSON.stringify({ token: null, manual: false }),
                },
              );
              s.messagesRead++;
            } catch {}
          }
        }
      } catch {}
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "Warmup tick failed (non-fatal)");
  }
}

function scheduleNext(token: string, s: WarmupState) {
  if (!s.active) return;
  if (Date.now() >= s.endsAt) {
    s.active = false;
    logger.info({ token: token.slice(0, 8) + "…" }, "Warmup completed");
    return;
  }
  // Random gap: 4–18 minutes between activity bursts. Plus 10% chance of a
  // 30–90 minute "user is away" gap. Caps at the warmup end-time.
  const longGap = Math.random() < 0.1;
  const baseDelay = longGap
    ? 30 * 60 * 1000 + Math.random() * 60 * 60 * 1000
    : 4 * 60 * 1000 + Math.random() * 14 * 60 * 1000;
  const delay = Math.min(baseDelay, Math.max(1000, s.endsAt - Date.now()));
  s.ticker = setTimeout(async () => {
    await tick(token, s);
    scheduleNext(token, s);
  }, delay);
}

export function startWarmup(token: string, days: number): { ok: boolean; endsAt: number } {
  if (!token || !Number.isFinite(days) || days <= 0) {
    return { ok: false, endsAt: 0 };
  }
  // Cancel any prior warmup
  const prev = WARMUPS.get(token);
  if (prev?.ticker) clearTimeout(prev.ticker);

  const now = Date.now();
  const endsAt = now + days * DAY_MS;
  const s: WarmupState = {
    startedAt: now,
    endsAt,
    active: true,
    ticker: null,
    lastTickAt: null,
    ticksDone: 0,
    channelsBrowsed: 0,
    guildsOpened: 0,
    messagesRead: 0,
  };
  WARMUPS.set(token, s);
  // Kick off the first tick after a small randomized delay so it doesn't fire
  // simultaneously with the user toggling it on.
  s.ticker = setTimeout(async () => {
    await tick(token, s);
    scheduleNext(token, s);
  }, 5000 + Math.random() * 25000);
  logger.info({ days, endsAt }, "Warmup started");
  return { ok: true, endsAt };
}

export function stopWarmup(token: string): { ok: boolean } {
  const s = WARMUPS.get(token);
  if (!s) return { ok: true };
  s.active = false;
  if (s.ticker) clearTimeout(s.ticker);
  s.ticker = null;
  WARMUPS.delete(token);
  return { ok: true };
}
