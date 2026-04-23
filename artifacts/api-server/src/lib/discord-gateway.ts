import WebSocket from "ws";
import { ProxyAgent } from "undici";
import { logger } from "./logger";
import { pickStableUA } from "./discord-headers";
import { createHash } from "crypto";

// One persistent gateway connection per token. Identifying on the gateway is
// what makes a Discord account appear as "online" — without it, the account
// is offline even if the REST token is valid. We reuse the same UA + super
// properties as the REST layer so the device fingerprint stays consistent.

type Status = "online" | "idle" | "dnd" | "invisible";

type Connection = {
  ws: WebSocket | null;
  status: Status;
  desiredOpen: boolean;
  heartbeat: ReturnType<typeof setInterval> | null;
  lastSeq: number | null;
  reconnectAttempts: number;
  identified: boolean;
  startedAt: number | null;
  sessionId: string | null;
  resumeUrl: string | null;
};

const CONNECTIONS = new Map<string, Connection>();

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const CLIENT_BUILD_NUMBER = 396421;

function getProxyAgent(): ProxyAgent | null {
  const url = process.env.DISCORD_OUTBOUND_PROXY?.trim();
  if (!url) return null;
  try {
    return new ProxyAgent(url);
  } catch {
    return null;
  }
}

function buildIdentifyProps(token: string) {
  const ua = pickStableUA(token);
  const isMac = ua.includes("Mac OS X");
  const isLinux = ua.includes("Linux");
  const os = isMac ? "Mac OS X" : isLinux ? "Linux" : "Windows";
  const launchId = createHash("sha256").update(ua).digest("hex").slice(0, 32);
  return {
    os,
    browser: "Chrome",
    device: "",
    system_locale: "en-US",
    has_client_mods: false,
    browser_user_agent: ua,
    browser_version: "131.0.0.0",
    os_version: isMac ? "10.15.7" : isLinux ? "" : "10",
    referrer: "",
    referring_domain: "",
    referrer_current: "",
    referring_domain_current: "",
    release_channel: "stable",
    client_build_number: CLIENT_BUILD_NUMBER,
    client_event_source: null,
    client_launch_id: launchId,
    client_app_state: "focused",
  };
}

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function identify(c: Connection, token: string) {
  if (!c.ws) return;
  send(c.ws, {
    op: 2,
    d: {
      token,
      capabilities: 16381,
      properties: buildIdentifyProps(token),
      presence: {
        status: c.status,
        since: 0,
        activities: [],
        afk: false,
      },
      compress: false,
      client_state: {
        guild_versions: {},
        highest_last_message_id: "0",
        read_state_version: 0,
        user_guild_settings_version: -1,
        user_settings_version: -1,
        private_channels_version: "0",
        api_code_version: 0,
      },
    },
  });
  c.identified = true;
}

function startHeartbeat(c: Connection, intervalMs: number) {
  if (c.heartbeat) clearInterval(c.heartbeat);
  // Discord recommends jittering the first heartbeat
  setTimeout(() => {
    if (c.ws && c.ws.readyState === WebSocket.OPEN) {
      send(c.ws, { op: 1, d: c.lastSeq });
    }
  }, Math.random() * intervalMs);
  c.heartbeat = setInterval(() => {
    if (c.ws && c.ws.readyState === WebSocket.OPEN) {
      send(c.ws, { op: 1, d: c.lastSeq });
    }
  }, intervalMs);
}

function teardown(c: Connection) {
  if (c.heartbeat) clearInterval(c.heartbeat);
  c.heartbeat = null;
  if (c.ws) {
    try { c.ws.removeAllListeners(); } catch {}
    try { c.ws.close(); } catch {}
  }
  c.ws = null;
  c.identified = false;
}

function open(token: string, c: Connection) {
  const agent = getProxyAgent();
  const ws = new WebSocket(GATEWAY_URL, {
    headers: {
      "User-Agent": pickStableUA(token),
      Origin: "https://discord.com",
    },
    ...(agent ? { dispatcher: agent } : {}),
  });
  c.ws = ws;

  ws.on("open", () => {
    c.reconnectAttempts = 0;
    c.startedAt = Date.now();
    logger.info("Discord gateway: socket opened");
  });

  ws.on("message", (data) => {
    let payload: any;
    try { payload = JSON.parse(data.toString()); } catch { return; }
    if (typeof payload.s === "number") c.lastSeq = payload.s;
    switch (payload.op) {
      case 10: {
        // HELLO — start heartbeat then identify
        startHeartbeat(c, payload.d.heartbeat_interval);
        identify(c, token);
        break;
      }
      case 11: {
        // HEARTBEAT ACK
        break;
      }
      case 7: {
        // RECONNECT
        teardown(c);
        scheduleReconnect(token, c);
        break;
      }
      case 9: {
        // INVALID SESSION
        c.sessionId = null;
        teardown(c);
        scheduleReconnect(token, c);
        break;
      }
      case 0: {
        if (payload.t === "READY") {
          c.sessionId = payload.d?.session_id ?? null;
          c.resumeUrl = payload.d?.resume_gateway_url ?? null;
          logger.info("Discord gateway: READY (account is now online)");
        }
        break;
      }
    }
  });

  ws.on("close", (code) => {
    logger.warn({ code }, "Discord gateway: socket closed");
    teardown(c);
    if (c.desiredOpen) scheduleReconnect(token, c);
  });

  ws.on("error", (err) => {
    logger.warn({ err: err?.message }, "Discord gateway: socket error");
  });
}

function scheduleReconnect(token: string, c: Connection) {
  c.reconnectAttempts += 1;
  const base = Math.min(60000, 1500 * 2 ** Math.min(c.reconnectAttempts, 5));
  const delay = base + Math.random() * 1000;
  setTimeout(() => {
    if (c.desiredOpen) open(token, c);
  }, delay);
}

export function startPresence(token: string, status: Status = "online"): { ok: boolean } {
  if (!token) return { ok: false };
  let c = CONNECTIONS.get(token);
  if (!c) {
    c = {
      ws: null,
      status,
      desiredOpen: true,
      heartbeat: null,
      lastSeq: null,
      reconnectAttempts: 0,
      identified: false,
      startedAt: null,
      sessionId: null,
      resumeUrl: null,
    };
    CONNECTIONS.set(token, c);
  } else {
    c.status = status;
    c.desiredOpen = true;
    if (c.ws && c.identified) {
      // Update presence status on existing connection
      send(c.ws, {
        op: 3,
        d: { status, since: 0, activities: [], afk: false },
      });
      return { ok: true };
    }
  }
  open(token, c);
  return { ok: true };
}

export function stopPresence(token: string): { ok: boolean } {
  const c = CONNECTIONS.get(token);
  if (!c) return { ok: true };
  c.desiredOpen = false;
  teardown(c);
  CONNECTIONS.delete(token);
  return { ok: true };
}

export function presenceStatus(token: string): {
  connected: boolean;
  status: Status | null;
  uptimeMs: number;
  sessionId: string | null;
} {
  const c = CONNECTIONS.get(token);
  if (!c) return { connected: false, status: null, uptimeMs: 0, sessionId: null };
  const connected = !!(c.ws && c.ws.readyState === WebSocket.OPEN && c.identified);
  return {
    connected,
    status: c.status,
    uptimeMs: c.startedAt ? Date.now() - c.startedAt : 0,
    sessionId: c.sessionId,
  };
}
