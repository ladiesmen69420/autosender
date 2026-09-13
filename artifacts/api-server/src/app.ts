import express, { type Express } from "express";
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

app.use(cors({
  credentials: true,
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (configuredOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin is not allowed by CORS"));
  },
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(clerkMiddleware());

app.use("/api", router);

export default app;
