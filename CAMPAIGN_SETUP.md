# Campaign creation troubleshooting

## What this fix changes
- In local Vite development, forward `/api` to Express on port 8080 instead of returning SPA HTML.
- Make frontend errors identify HTTP 404, 502, 503, 500, non-JSON responses, and API-provided validation details.
- Identify missing PostgreSQL campaign tables/columns (42P01/42703) and common connection failures without exposing SQL or tokens.
- Use the correct `@workspace/db` package filter for post-merge database schema sync.
- Register the web artifact explicitly in Replit; remove committed Clerk credentials from `.replit`.

## Before deployment
1. In Replit Secrets, configure `DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, and `VITE_CLERK_PUBLISHABLE_KEY`; configure OpenAI credentials if AI features are used.
2. The former Clerk secret was committed publicly. **Rotate/revoke the old secret in Clerk** and update Replit Secrets. Removing it from a new commit does not erase Git history.
3. Run `pnpm install --frozen-lockfile` and `pnpm --filter @workspace/db run push` against the correct deployed PostgreSQL database. Review schema changes before accepting them.
4. Redeploy both API and frontend.
5. From the same hostname as the frontend, verify `GET /api/healthz` returns JSON. Sign in and try creating a campaign with valid fields (no messaging should start just by saving it).

If creation fails, inspect `POST /api/campaigns` in browser DevTools → Network. 404 or HTML suggests a routing problem, 401 suggests authentication, 502/503 suggests backend availability, and JSON 503 with a schema warning means database schema needs updating. Look for the server-side “Failed to insert campaign” log to find the underlying database error. Never paste access tokens or secrets into issue reports.

## Validation limitations
Static review has verified the request path, code changes and configuration, but this PR has not been integration-tested with the user's live Clerk session and PostgreSQL database. Railway/Vercel deployment statuses are distinct from functional API tests.
