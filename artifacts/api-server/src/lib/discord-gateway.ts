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
  heartbeatWatchdog: ReturnType<typeof setTimeout> | null;
  lastSeq: number | null;
  lastHeartbeatAcked: boolean;
  heartbeatInterval: number;
  reconnectAttempts: number;
  identified: boolean;
  startedAt: number | null;
  sessionId: string | null;
  resumeUrl: string | null;
};

const CONNECTIONS = new Map<string, Connection>();

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const CLIENT_BUILD_NUMBER = 396421;

// Close codes from which reconnecting is pointless (unrecoverable auth / config errors)
const NON_RESUMABLE_CLOSE_CODES = new Set([
  4004, // Authentication failed — bad token
  4010, // Invalid shard
  4011, // Sharding required
  4012, // Invalid API version
  4013, // Invalid intents
  4014, // Disallowed intents
]);

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

function clearHeartbeat(c: Connection) {
  if (c.heartbeat) {
    clearInterval(c.heartbeat);
    c.heartbeat = null;
  }
  if (c.heartbeatWatchdog) {
    clearTimeout(c.heartbeatWatchdog);
    c.heartbeatWatchdog = null;
  }
}

function startHeartbeat(token: string, c: Connection, intervalMs: number) {
  clearHeartbeat(c);
  c.heartbeatInterval = intervalMs;
  c.lastHeartbeatAcked = true; // treat as acked at start

  function sendHeartbeat() {
    if (!c.ws || c.ws.readyState !== WebSocket.OPEN) return;

    if (!c.lastHeartbeatAcked) {
      // Previous heartbeat was never acked — connection is a zombie
      logger.warn("Discord gateway: heartbeat not acked — forcing reconnect (zombie connection)");
      try { c.ws.terminate(); } catch {}
      return;
    }

    c.lastHeartbeatAcked = false;
    send(c.ws, { op: 1, d: c.lastSeq });

    // Watchdog: if no ack comes within 20s, force-close
    if (c.heartbeatWatchdog) clearTimeout(c.heartbeatWatchdog);
    c.heartbeatWatchdog = setTimeout(() => {
      if (!c.lastHeartbeatAcked && c.ws && c.ws.readyState === WebSocket.OPEN) {
        logger.warn("Discord gateway: heartbeat ack watchdog fired — terminating zombie connection");
        try { c.ws.terminate(); } catch {}
      }
    }, Math.min(20000, intervalMs - 1000));
  }

  // Discord recommends jittering the first heartbeat
  const jitterDelay = Math.random() * intervalMs;
  setTimeout(() => {
    sendHeartbeat();
    c.heartbeat = setInterval(sendHeartbeat, intervalMs);
  }, jitterDelay);
}

function teardown(c: Connection) {
  clearHeartbeat(c);
  if (c.ws) {
    try { c.ws.removeAllListeners(); } catch {}
    try { c.ws.terminate(); } catch {}
  }
  c.ws = null;
  c.identified = false;
  c.lastHeartbeatAcked = true;
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
    c.startedAt = c.startedAt ?? Date.now();
    logger.info("Discord gateway: socket opened");
  });

  ws.on("message", (data) => {
    let payload: any;
    try { payload = JSON.parse(data.toString()); } catch { return; }
    if (typeof payload.s === "number") c.lastSeq = payload.s;
    switch (payload.op) {
      case 10: {
        // HELLO — start heartbeat then identify
        startHeartbeat(token, c, payload.d.heartbeat_interval);
        identify(c, token);
        break;
      }
      case 11: {
        // HEARTBEAT ACK — connection is alive
        c.lastHeartbeatAcked = true;
        if (c.heartbeatWatchdog) {
          clearTimeout(c.heartbeatWatchdog);
          c.heartbeatWatchdog = null;
        }
        break;
      }
      case 1: {
        // HEARTBEAT request from Discord — send one immediately
        if (c.ws && c.ws.readyState === WebSocket.OPEN) {
          send(c.ws, { op: 1, d: c.lastSeq });
        }
        break;
      }
      case 7: {
        // RECONNECT requested by Discord
        logger.info("Discord gateway: server requested reconnect");
        teardown(c);
        scheduleReconnect(token, c);
        break;
      }
      case 9: {
        // INVALID SESSION
        const resumable = payload.d === true;
        logger.warn({ resumable }, "Discord gateway: invalid session");
        c.sessionId = resumable ? c.sessionId : null;
        teardown(c);
        scheduleReconnect(token, c);
        break;
      }
      case 0: {
        if (payload.t === "READY") {
          c.sessionId = payload.d?.session_id ?? null;
          c.resumeUrl = payload.d?.resume_gateway_url ?? null;
          c.startedAt = Date.now();
          logger.info("Discord gateway: READY — account is now online");
        }
        break;
      }
    }
  });

  ws.on("close", (code, reason) => {
    const reasonStr = reason?.toString() ?? "";
    logger.warn({ code, reason: reasonStr }, "Discord gateway: socket closed");
    teardown(c);

    if (!c.desiredOpen) return;

    if (NON_RESUMABLE_CLOSE_CODES.has(code)) {
      logger.error(
        { code },
        "Discord gateway: received non-resumable close code — stopping presence (check token validity)",
      );
      c.desiredOpen = false;
      CONNECTIONS.delete(token);
      return;
    }

    scheduleReconnect(token, c);
  });

  ws.on("error", (err) => {
    logger.warn({ error: err?.message }, "Discord gateway: socket error");
  });
}

function scheduleReconnect(token: string, c: Connection) {
  if (!c.desiredOpen) return;
  c.reconnectAttempts += 1;
  const base = Math.min(60000, 1500 * 2 ** Math.min(c.reconnectAttempts, 5));
  const delay = base + Math.random() * 1000;
  logger.info({ attempt: c.reconnectAttempts, delayMs: Math.round(delay) }, "Discord gateway: scheduling reconnect");
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
      heartbeatWatchdog: null,
      lastSeq: null,
      lastHeartbeatAcked: true,
      heartbeatInterval: 41250,
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
    if (c.ws && c.ws.readyState === WebSocket.OPEN && c.identified) {
      // Update presence status on existing connection
      send(c.ws, {
        op: 3,
        d: { status, since: 0, activities: [], afk: false },
      });
      return { ok: true };
    }
    // Connection exists but is not open/identified — let it reconnect naturally or open now
    if (!c.ws || c.ws.readyState === WebSocket.CLOSED || c.ws.readyState === WebSocket.CLOSING) {
      open(token, c);
    }
    return { ok: true };
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
  desiredOpen: boolean;
} {
  const c = CONNECTIONS.get(token);
  if (!c) return { connected: false, status: null, uptimeMs: 0, sessionId: null, desiredOpen: false };
  const connected = !!(c.ws && c.ws.readyState === WebSocket.OPEN && c.identified);
  return {
    connected,
    status: c.status,
    uptimeMs: c.startedAt ? Date.now() - c.startedAt : 0,
    sessionId: c.sessionId,
    desiredOpen: c.desiredOpen,
  };
}
