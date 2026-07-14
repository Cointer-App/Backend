import { env } from "../config/env";
import { getDb, now } from "../db/client";
import type { ChannelRow, ChannelType } from "../types";
import { ValidationError } from "./pushTokenService";

const CHANNEL_TYPES = new Set<ChannelType>(["ntfy", "discord", "slack", "email"]);

const DISCORD_WEBHOOK_RE =
  /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/;
const SLACK_WEBHOOK_RE =
  /^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[A-Za-z0-9/_-]+$/;
const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("Invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError("URL must be http(s)");
  }
  if (url.username || url.password) throw new ValidationError("URL must not contain credentials");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".")
  ) {
    throw new ValidationError("URL host must be a public hostname");
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    const isPrivate =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224;
    if (isPrivate) throw new ValidationError("URL host must not be a private or reserved IP");
  }
  if (host.includes(":")) {
    throw new ValidationError("IPv6 literal hosts are not allowed, use a hostname");
  }
  return url;
}

export function validateChannelConfig(type: ChannelType, config: unknown): string {
  if (typeof config !== "object" || config === null) {
    throw new ValidationError("config must be an object");
  }
  const cfg = config as Record<string, unknown>;

  switch (type) {
    case "ntfy": {
      const topic = cfg.topic;
      if (typeof topic !== "string" || !NTFY_TOPIC_RE.test(topic)) {
        throw new ValidationError("ntfy config requires a topic (letters, digits, - and _)");
      }
      let server = "https://ntfy.sh";
      if (cfg.server !== undefined) {
        if (typeof cfg.server !== "string") throw new ValidationError("server must be a string");
        server = assertPublicHttpUrl(cfg.server).origin;
      }
      return JSON.stringify({ server, topic });
    }
    case "discord": {
      const url = cfg.url;
      if (typeof url !== "string" || !DISCORD_WEBHOOK_RE.test(url)) {
        throw new ValidationError("discord config requires a valid Discord webhook url");
      }
      return JSON.stringify({ url });
    }
    case "slack": {
      const url = cfg.url;
      if (typeof url !== "string" || !SLACK_WEBHOOK_RE.test(url)) {
        throw new ValidationError("slack config requires a valid Slack webhook url");
      }
      return JSON.stringify({ url });
    }
    case "email": {
      if (!env.smtp && !env.cloudflareEmail) {
        throw new ValidationError("Email notifications are not configured on this server");
      }
      const to = cfg.to;
      if (typeof to !== "string" || !EMAIL_RE.test(to)) {
        throw new ValidationError('email config requires a valid address in "to"');
      }
      return JSON.stringify({ to: to.toLowerCase() });
    }
  }
}

export function previewConfig(type: ChannelType, configJson: string): Record<string, unknown> {
  const cfg = JSON.parse(configJson) as Record<string, string>;
  switch (type) {
    case "ntfy":
      return { server: cfg.server, topic: cfg.topic };
    case "discord":
    case "slack": {
      const url = cfg.url ?? "";
      return { url: `${new URL(url).origin}/…${url.slice(-4)}` };
    }
    case "email":
      return { to: cfg.to };
  }
}

function toPublicChannel(row: ChannelRow) {
  return {
    id: row.id,
    type: row.type,
    enabled: row.enabled === 1,
    config: previewConfig(row.type, row.config),
    createdAt: row.created_at,
  };
}

export function listChannels(personalKeyId: string) {
  return getDb()
    .query<ChannelRow, [string]>(
      "SELECT * FROM channels WHERE personal_key_id = ? ORDER BY created_at",
    )
    .all(personalKeyId)
    .map(toPublicChannel);
}

export function getChannel(personalKeyId: string, channelId: string): ChannelRow | null {
  return (
    getDb()
      .query<ChannelRow, [string, string]>(
        "SELECT * FROM channels WHERE id = ? AND personal_key_id = ?",
      )
      .get(channelId, personalKeyId) ?? null
  );
}

export function addChannel(personalKeyId: string, type: unknown, config: unknown) {
  if (typeof type !== "string" || !CHANNEL_TYPES.has(type as ChannelType)) {
    throw new ValidationError(`type must be one of: ${[...CHANNEL_TYPES].join(", ")}`);
  }
  const db = getDb();
  const count = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM channels WHERE personal_key_id = ?")
    .get(personalKeyId)!.n;
  if (count >= env.limits.maxChannelsPerKey) {
    throw new ValidationError(`Channel limit reached (${env.limits.maxChannelsPerKey})`);
  }

  const configJson = validateChannelConfig(type as ChannelType, config);
  const id = crypto.randomUUID();
  db.run(
    "INSERT INTO channels (id, personal_key_id, type, config, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)",
    [id, personalKeyId, type, configJson, now()],
  );
  return toPublicChannel(getChannel(personalKeyId, id)!);
}

export function updateChannel(
  personalKeyId: string,
  channelId: string,
  patch: { enabled?: unknown; config?: unknown },
) {
  const row = getChannel(personalKeyId, channelId);
  if (!row) return null;

  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    throw new ValidationError("enabled must be a boolean");
  }
  const configJson =
    patch.config !== undefined ? validateChannelConfig(row.type, patch.config) : null;

  if (patch.enabled !== undefined) {
    getDb().run("UPDATE channels SET enabled = ? WHERE id = ?", [patch.enabled ? 1 : 0, row.id]);
  }
  if (configJson !== null) {
    getDb().run("UPDATE channels SET config = ? WHERE id = ?", [configJson, row.id]);
  }
  return toPublicChannel(getChannel(personalKeyId, channelId)!);
}

export function removeChannel(personalKeyId: string, channelId: string): boolean {
  const res = getDb().run("DELETE FROM channels WHERE id = ? AND personal_key_id = ?", [
    channelId,
    personalKeyId,
  ]);
  return res.changes > 0;
}
