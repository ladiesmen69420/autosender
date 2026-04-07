import { Router } from "express";
import { createClerkClient } from "@clerk/express";

const router = Router();

function getAppUrl(): string {
  const domain = process.env.REPLIT_DEV_DOMAIN;
  if (domain) return `https://${domain}`;
  return `http://localhost:${process.env.PORT ?? 8080}`;
}

function getDiscordRedirectUri(): string {
  return `${getAppUrl()}/api/auth/discord/callback`;
}

router.get("/discord", (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) {
    res.status(503).send("Discord OAuth not configured. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET env vars.");
    return;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getDiscordRedirectUri(),
    response_type: "code",
    scope: "identify email",
  });

  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

router.get("/discord/callback", async (req, res) => {
  const { code, error } = req.query;
  const appUrl = getAppUrl();

  if (error || !code) {
    res.redirect(`${appUrl}/?auth_error=cancelled`);
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
        redirect_uri: getDiscordRedirectUri(),
      }),
    });

    const tokenData = await tokenRes.json() as { access_token?: string };
    if (!tokenData.access_token) throw new Error("No access token from Discord");

    const userRes = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json() as {
      id: string; username: string; email?: string; discriminator?: string;
    };

    if (!discordUser.id) throw new Error("Failed to get Discord user info");

    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

    let clerkUser;

    if (discordUser.email) {
      const found = await clerk.users.getUserList({ emailAddress: [discordUser.email] });
      clerkUser = found.data[0];
    }

    if (!clerkUser) {
      const createParams: Parameters<typeof clerk.users.createUser>[0] = {
        externalId: `discord_${discordUser.id}`,
        firstName: discordUser.username,
        skipPasswordRequirement: true,
      };
      if (discordUser.email) {
        createParams.emailAddress = [discordUser.email];
        createParams.skipPasswordRequirement = true;
      }
      clerkUser = await clerk.users.createUser(createParams);
    }

    const signInToken = await clerk.signInTokens.createSignInToken({
      userId: clerkUser.id,
      expiresInSeconds: 120,
    });

    res.redirect(`${appUrl}/discord-signin?token=${encodeURIComponent(signInToken.token)}`);
  } catch (err) {
    console.error("Discord OAuth error:", err);
    res.redirect(`${getAppUrl()}/?auth_error=failed`);
  }
});

export default router;
