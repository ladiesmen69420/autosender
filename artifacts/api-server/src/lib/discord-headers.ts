import { createHash } from "crypto";

const CLIENT_BUILD_NUMBER = 333390;

type Profile = {
  ua: string;
  browser: "Chrome" | "Firefox" | "Safari" | "Edge";
  browserVersion: string;
  os: "Windows" | "Mac OS X" | "Linux";
  osVersion: string;
};

const PROFILES: Profile[] = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    browser: "Chrome",
    browserVersion: "124.0.0.0",
    os: "Windows",
    osVersion: "10",
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    browser: "Chrome",
    browserVersion: "124.0.0.0",
    os: "Mac OS X",
    osVersion: "10.15.7",
  },
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    browser: "Chrome",
    browserVersion: "124.0.0.0",
    os: "Linux",
    osVersion: "",
  },
];

const TIMEZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Europe/London",
  "Europe/Berlin",
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
 * mismatch checks) is far less likely to flag the request.
 *
 * Headers are stable per token: the same token always produces the same
 * UA + super-properties + timezone, mimicking a single device fingerprint.
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
    "X-Discord-Locale": "en-US",
    "X-Discord-Timezone": tz,
    "X-Super-Properties": buildSuperProps(profile),
    "X-Debug-Options": "bugReporterEnabled",
  };

  if (opts.contentType !== false) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

export function pickStableUA(token: string): string {
  return pickStable(token, PROFILES).ua;
}
