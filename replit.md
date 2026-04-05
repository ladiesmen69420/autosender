# Workspace

## Overview

**ballistiballs adv** — A Discord AutoSender web app (selfbot) that automates Discord messaging via server-side campaign scheduling (runs 24/7 even when browser is closed), manages tokens, and uses AI to generate context-aware DM replies. Dark cyber/futuristic command-center UI.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Frontend**: React + Vite + TailwindCSS v4 + shadcn/ui components
- **Backend**: Express.js (pino logging, Zod validation)
- **Database**: PostgreSQL via Drizzle ORM
- **AI**: OpenAI via Replit AI Integrations proxy (gpt-5.2) — no user API key needed
- **API validation**: OpenAPI spec + orval codegen for typed hooks

## Artifacts

- `artifacts/discord-autosender` — React frontend (port from `PORT` env)
- `artifacts/api-server` — Express API server (port 8080)

## Architecture

```
artifacts/
  discord-autosender/     # React+Vite frontend
  api-server/             # Express backend
lib/
  api-spec/               # OpenAPI spec + orval codegen (react-query hooks)
  db/                     # Drizzle ORM schema + migrations
```

## Features

1. **Dashboard** — Stats overview, quick actions, recent activity log
2. **AutoSender** — Broadcast messages to multiple channels with configurable delay, jitter, repeat bypass, and saved presets
3. **AI Reply** — Generate natural DM replies with a custom persona, auto-reply mode (60s scan), DM conversation browser
4. **Tokens** — Validate Discord user tokens with live account info
5. **Logs** — Real-time filterable activity log

## Database Schema

### `sessions` table
- `id` (serial PK), `name` (text), `token` (text), `channels` (text[]), `message` (text)
- `delay` (int, default 5), `repeat_bypass` (bool), `jitter` (int, default 0)
- `created_at` (timestamp)

## API Routes (`/api/discord/*`)

| Method | Path | Description |
|--------|------|-------------|
| POST | /validate-token | Validate a Discord user token |
| POST | /send-messages | Send to multiple channels |
| POST | /dms | Fetch DM conversations |
| POST | /ai-reply | Generate + optionally send AI reply |
| POST | /auto-reply | Scan all DMs and auto-reply with AI |
| GET | /sessions | List saved presets |
| POST | /sessions | Create preset |
| DELETE | /sessions/:id | Delete preset |

## Key Implementation Details

- Discord API v10 used; token passed as `Authorization` header directly
- Jitter: `delay * 1000 + delay * 1000 * (random * jitter/100)` ms
- Repeat bypass: appends random 15-digit number to message content
- Auto-reply polls DMs every 60s via frontend `setInterval`
- OpenAI model: `gpt-5.2`, max 200 tokens per reply
- Sessions table has `jitter` column (integer, default 0)

## Disclaimer

Uses Discord user tokens (selfbot) — violates Discord ToS. Disclaimer shown prominently in UI.
