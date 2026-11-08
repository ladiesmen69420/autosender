import express, { type Express, type Request } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

const configuredOrigins = new Set([
  ...(process.env.CORS_ALLOWED_ORIGINS ?? "").split(","),
  process.env.APP_ORIGIN ?? "",
  process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "",
  ...(process.env.NODE_ENV !== "production" ? ["http://localhost:5173", "http://127.0.0.1:5173"] : []),
].map((origin) => origin.trim()).filter(Boolean));

function getRequestOrigin(req: Request): string | null {
  const host = (req.get("x-forwarded-host") ?? req.get("host") ?? "").split(",")[0].trim();
  const protocol = (req.get("x-forwarded-proto") ?? req.protocol ?? "https")
    .split(",")[0]
    .trim()
    .replace(/:$/, "");
  if (!host || (protocol !== "http" && protocol !== "https")) return null;

  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return null;
  }
}

app.use((req, res, next) => {
  const requestOrigin = getRequestOrigin(req);
  cors({
    credentials: true,
    origin: (origin, callback) => {
      if (!origin || configuredOrigins.has(origin) || origin === requestOrigin) {
        callback(null, true);
        return;
      }

      // A disallowed browser origin should fail its CORS check, not turn into
      // an application 500. Sensitive API routes still enforce Clerk auth.
      req.log.warn({ origin, method: req.method, path: req.path }, "CORS origin rejected");
      callback(null, false);
    },
  })(req, res, next);
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(clerkMiddleware());

app.use("/api", router);

export default app;
