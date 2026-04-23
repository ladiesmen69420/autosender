import { ProxyAgent, fetch as undiciFetch, type RequestInit } from "undici";
import { logger } from "./logger";

let cachedAgent: ProxyAgent | null | undefined;

function getAgent(): ProxyAgent | null {
  if (cachedAgent !== undefined) return cachedAgent;
  const url = process.env.DISCORD_OUTBOUND_PROXY?.trim();
  if (!url) {
    cachedAgent = null;
    return null;
  }
  try {
    cachedAgent = new ProxyAgent(url);
    logger.info(
      { proxy: url.replace(/(:\/\/)([^:]+):([^@]+)@/, "$1***:***@") },
      "Discord outbound proxy enabled",
    );
  } catch (err) {
    logger.error({ err }, "Failed to init Discord outbound proxy; falling back to direct");
    cachedAgent = null;
  }
  return cachedAgent;
}

/**
 * Drop-in fetch for any Discord API call. When DISCORD_OUTBOUND_PROXY is set
 * (e.g. a residential / mobile-IP proxy), all Discord traffic is routed
 * through it — bypassing IP-reputation checks against the datacenter ranges
 * Replit and similar hosts publish.
 */
export async function discordFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const agent = getAgent();
  const opts: RequestInit = agent ? { ...init, dispatcher: agent } : init;
  // Cast back to the global Response type the rest of the codebase uses.
  const res = await undiciFetch(input, opts);
  return res as unknown as Response;
}

export function isProxyConfigured(): boolean {
  return !!process.env.DISCORD_OUTBOUND_PROXY?.trim();
}
