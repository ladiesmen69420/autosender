# Workspace

## Overview

Discord AutoSender — a web-based tool to automatically send messages to Discord channels using a user token (selfbot). Dark-themed, command-center UI.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite + Tailwind CSS (dark Discord theme)

## Features

- Token validation via Discord API v10
- Multi-channel targeting
- Configurable delay and repeat bypass
- Live execution log with sent/failed counters
- Saved presets/sessions stored in PostgreSQL

## API Routes

- `POST /api/discord/validate-token` — validate Discord user token
- `POST /api/discord/send-messages` — send message to channels
- `GET /api/discord/sessions` — list saved sessions
- `POST /api/discord/sessions` — save a session
- `DELETE /api/discord/sessions/:id` — delete a session

## DB Schema

- `sessions` — saved autosender configs (name, token, channels, message, delay, repeatBypass)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
