import { createMiddleware } from "hono/factory";
import { env } from "../config/env";
import type { AppEnv } from "../types";

interface Bucket {
  count: number;
  resetAt: number;
}

export function createLimiter(limit: number, windowMs: number) {
  const buckets = new Map<string, Bucket>();

  const sweeper = setInterval(() => {
    const t = Date.now();
    for (const [k, b] of buckets) {
      if (b.resetAt <= t) buckets.delete(k);
    }
  }, 60_000);
  if (typeof sweeper === "object" && "unref" in sweeper) sweeper.unref();

  return {
    check(key: string): { allowed: boolean; retryAfterSec: number } {
      const t = Date.now();
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= t) {
        buckets.set(key, { count: 1, resetAt: t + windowMs });
        return { allowed: true, retryAfterSec: 0 };
      }
      bucket.count++;
      if (bucket.count > limit) {
        return { allowed: false, retryAfterSec: Math.ceil((bucket.resetAt - t) / 1000) };
      }
      return { allowed: true, retryAfterSec: 0 };
    },
  };
}

export function getClientIp(c: {
  env: AppEnv["Bindings"];
  req: { header(name: string): string | undefined };
}): string {
  if (env.trustProxy) {
    const value = c.req.header(env.trustProxyHeader);
    if (value) {
      if (env.trustProxyHeader === "x-forwarded-for") {
        const last = value.split(",").at(-1)?.trim();
        if (last) return last;
      } else {
        return value.trim();
      }
    }
  }
  return c.env?.ip ?? "unknown";
}

function tooMany(retryAfterSec: number) {
  return new Response(JSON.stringify({ error: "Too many requests" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(Math.max(retryAfterSec, 1)),
    },
  });
}

const globalLimiter = createLimiter(120, 60_000);
export const globalRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const { allowed, retryAfterSec } = globalLimiter.check(getClientIp(c));
  if (!allowed) return tooMany(retryAfterSec);
  await next();
});

const mintLimiter = createLimiter(5, 60 * 60_000);
export const keyMintRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const { allowed, retryAfterSec } = mintLimiter.check(getClientIp(c));
  if (!allowed) return tooMany(retryAfterSec);
  await next();
});

const keyLimiter = createLimiter(60, 60_000);
export const perKeyRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const { allowed, retryAfterSec } = keyLimiter.check(c.get("personalKeyId"));
  if (!allowed) return tooMany(retryAfterSec);
  await next();
});

const channelTestLimiter = createLimiter(10, 60 * 60_000);
export const channelTestRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const { allowed, retryAfterSec } = channelTestLimiter.check(c.get("personalKeyId"));
  if (!allowed) return tooMany(retryAfterSec);
  await next();
});
