import { createHash } from "crypto";

// Tracks an actual recent stable Discord web build. Discord's anti-abuse looks
// for old/invalid build numbers as a strong "selfbot" signal — keep this fresh.
const CLIENT_BUILD_NUMBER = 396421;

type Profile = {
  ua: string;
  browser: "Chrome" | "Edge";
  browserVersion: string;
  os: "Windows" | "Mac OS X" | "Linux";
  osVersion: string;
  // Client-Hint values must match the UA exactly; mismatches are a flag.
  secChUa: string;
  secChUaPlatform: string;
};

const CHROME_VER = "131.0.0.0";
const CHROME_MAJOR = "131";

const PROFILES: Profile[] = [
  {
    ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER} Safari/537.36`,
    browser: "Chrome",
    browserVersion: CHROME_VER,
    os: "Windows",
    osVersion: "10",
    secChUa: `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not_A Brand";v="24"`,
    secChUaPlatform: '"Windows"',
  },
  {
    ua: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER} Safari/537.36`,
    browser: "Chrome",
    browserVersion: CHROME_VER,
    os: "Mac OS X",
    osVersion: "10.15.7",
    secChUa: `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not_A Brand";v="24"`,
    secChUaPlatform: '"macOS"',
  },
  {
    ua: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER} Safari/537.36`,
    browser: "Chrome",
    browserVersion: CHROME_VER,
    os: "Linux",
    osVersion: "",
    secChUa: `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not_A Brand";v="24"`,
    secChUaPlatform: '"Linux"',
  },
];

const TIMEZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "America/Denver",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Amsterdam",
];

function pickStable<T>(token: string, list: T[], salt = ""): T {
  const h = createHash("sha256").update(token + salt).digest();
  return list[h[0] % list.length];
}

function buildSuperProps(p: Profile): string {
  const props = {
    os: p.os,
    browser: p.browser,
    device: "",
    system_locale: "en-US",
    has_client_mods: false,
    browser_user_agent: p.ua,
    browser_version: p.browserVersion,
    os_version: p.osVersion,
    referrer: "",
    referring_domain: "",
    referrer_current: "",
    referring_domain_current: "",
    release_channel: "stable",
    client_build_number: CLIENT_BUILD_NUMBER,
    client_event_source: null,
    client_launch_id: createHash("sha256").update(p.ua).digest("hex").slice(0, 32),
    client_app_state: "focused",
  };
  return Buffer.from(JSON.stringify(props)).toString("base64");
}

export type FingerprintOptions = {
  ua?: string;
  contentType?: boolean;
};

/**
 * Build headers that match the official Discord web client so that
 * Discord's "unofficial client" detection (X-Super-Properties / UA / locale
 * / sec-ch-ua mismatch checks) is far less likely to flag the request.
 *
 * Headers are stable per token: the same token always produces the same
 * UA + super-properties + timezone + sec-ch-ua, mimicking a single device
 * fingerprint that persists across sessions (matching what real browsers do).
 */
export function discordHeaders(
  token: string,
  opts: FingerprintOptions = {},
): Record<string, string> {
  const profile = opts.ua
    ? PROFILES.find((p) => p.ua === opts.ua) ?? pickStable(token, PROFILES)
    : pickStable(token, PROFILES);
  const tz = pickStable(token, TIMEZONES, "tz");

  const headers: Record<string, string> = {
    Authorization: token,
    "User-Agent": profile.ua,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://discord.com",
    Referer: "https://discord.com/channels/@me",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Ch-Ua": profile.secChUa,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": profile.secChUaPlatform,
    "X-Discord-Locale": "en-US",
    "X-Discord-Timezone": tz,
    "X-Super-Properties": buildSuperProps(profile),
    "X-Debug-Options": "bugReporterEnabled",
    Priority: "u=1, i",
  };

  if (opts.contentType !== false) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

export function pickStableUA(token: string): string {
  return pickStable(token, PROFILES).ua;
}
