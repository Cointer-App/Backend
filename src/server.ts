import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { env } from "./config/env";
import { resetDb } from "./db/client";
import { startWatchers, stopWatchers } from "./ingest";
import { globalRateLimit } from "./middleware/rateLimit";
import { startPriceFeed, stopPriceFeed } from "./prices";
import { api } from "./routes";
import { pruneOldActivity } from "./services/activityService";
import type { AppEnv } from "./types";

export function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: env.corsOrigins.includes("*") ? "*" : env.corsOrigins,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      maxAge: 86400,
    }),
  );

  // Never log headers or bodies, they carry the personal key.
  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    const ms = (performance.now() - start).toFixed(1);
    console.log(`${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${ms}ms`);
  });

  app.use("*", globalRateLimit);

  app.route("/", api);

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((err, c) => {
    console.error(`[error] ${c.req.method} ${new URL(c.req.url).pathname}:`, err);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}

export function startServer() {
  const app = buildApp();

  const server = Bun.serve({
    port: env.port,
    // Bun defaults to 10s, which cuts off requests that wait on a slow
    // downstream, like a channel test against an unresponsive SMTP host.
    idleTimeout: 30,
    fetch: (req, srv) => app.fetch(req, { ip: srv.requestIP(req)?.address }),
  });

  const retention = setInterval(pruneOldActivity, 24 * 60 * 60 * 1000);
  if (typeof retention === "object" && "unref" in retention) retention.unref();
  pruneOldActivity();

  startWatchers();
  startPriceFeed();

  const shutdown = (signal: string) => {
    console.log(`[server] received ${signal}, shutting down`);
    clearInterval(retention);
    stopWatchers();
    stopPriceFeed();
    server.stop();
    resetDb();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  console.log(`Cointer backend listening on http://localhost:${server.port}`);
  return server;
}
