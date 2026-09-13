import { Router, type Request } from "express";
import { createClerkClient } from "@clerk/express";
import { randomBytes } from "node:crypto";
import { logger } from "../lib/logger";

const router = Router();
const oauthStates = new Map<string, number>();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function getBaseUrl(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] ?? req.protocol ?? "https";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "";
  return `${proto}://${host}`;
}

function getDiscordRedirectUri(req: Request): string {
  return `${getBaseUrl(req)}/api/auth/discord/callback`;
}

router.get("/discord", (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) {
    res.status(503).send(
      "Discord OAuth not configured — please add DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET to Replit Secrets, then restart the API server."
    );
    return;
  }

  const redirectUri = getDiscordRedirectUri(req);
  const state = randomBytes(32).toString("hex");
  oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
  for (const [savedState, expiresAt] of oauthStates) {
    if (expiresAt <= Date.now()) oauthStates.delete(savedState);
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify email",
    state,
  });

  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

router.get("/discord/callback", async (req, res) => {
  const { code, error, state } = req.query;
  const baseUrl = getBaseUrl(req);

  const savedExpiry = typeof state === "string" ? oauthStates.get(state) : undefined;
  if (typeof state !== "string" || !savedExpiry || savedExpiry <= Date.now()) {
    if (typeof state === "string") oauthStates.delete(state);
    res.redirect(`${baseUrl}/?auth_error=invalid_state`);
    return;
  }
  oauthStates.delete(state);

  if (error || !code) {
    res.redirect(`${baseUrl}/?auth_error=cancelled`);
    return;
  }

  try {
    const clientId = process.env.DISCORD_CLIENT_ID!;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET!;

    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: getDiscordRedirectUri(req),
      }),
    });

    const tokenData = await tokenRes.json() as { access_token?: string };
    if (!tokenData.access_token) throw new Error("No access token from Discord");

    const userRes = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) throw new Error("Failed to verify Discord identity");
    const discordUser = await userRes.json() as {
      id: string; username: string; email?: string; verified?: boolean; discriminator?: string;
    };

    if (!discordUser.id || !discordUser.email || discordUser.verified !== true) {
      throw new Error("Discord returned an unverified or incomplete identity");
    }

    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

    let clerkUser;

    const found = await clerk.users.getUserList({ emailAddress: [discordUser.email] });
    clerkUser = found.data[0];

    if (!clerkUser) {
      const createParams: Parameters<typeof clerk.users.createUser>[0] = {
        externalId: `discord_${discordUser.id}`,
        firstName: discordUser.username,
        skipPasswordRequirement: true,
      };
      createParams.emailAddress = [discordUser.email];
      createParams.skipPasswordRequirement = true;
      clerkUser = await clerk.users.createUser(createParams);
    }

    const signInToken = await clerk.signInTokens.createSignInToken({
      userId: clerkUser.id,
      expiresInSeconds: 300,
    });

    res.redirect(`${baseUrl}/discord-signin?token=${encodeURIComponent(signInToken.token)}`);
  } catch (err) {
    logger.error({ err }, "Discord OAuth error");
    res.redirect(`${baseUrl}/?auth_error=failed`);
  }
});

export default router;
