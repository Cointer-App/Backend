import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "../config/env";
import { getDb } from "../db/client";
import { formatFiat, getPrice } from "../prices";
import type { ChannelRow, ChannelType, NotificationEvent, PushTokenRow } from "../types";
import { removeDeadToken } from "./pushTokenService";

const SEND_TIMEOUT_MS = 10_000;

function shortAddress(address: string): string {
  return address.length <= 16 ? address : `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function shortHash(hash: string): string {
  return hash.length <= 12 ? hash : `${hash.slice(0, 10)}…`;
}

export function buildMessage(event: NotificationEvent): { title: string; body: string } {
  const prefix = event.isTest ? "[TEST] " : "";
  const quote = getPrice(event.asset);
  const amountNum = Number(event.amount);
  const fiat =
    quote &&
    Number.isFinite(amountNum) &&
    amountNum >= 0 &&
    Number.isFinite(amountNum * quote.value)
      ? ` (≈ ${formatFiat(amountNum * quote.value)})`
      : "";
  return {
    title: `${prefix}Incoming ${event.asset}`,
    body: `${event.amount} ${event.asset}${fiat} received at ${shortAddress(event.address)} (tx ${shortHash(event.txHash)}) on ${event.chainName}`,
  };
}

async function sendNtfy(
  cfg: { server: string; topic: string },
  event: NotificationEvent,
): Promise<void> {
  const { title, body } = buildMessage(event);
  const res = await fetch(`${cfg.server}/${cfg.topic}`, {
    method: "POST",
    headers: {
      Title: title,
      Priority: "default",
    },
    body,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    redirect: "error",
  });
  if (!res.ok) throw new Error(`ntfy returned ${res.status}`);
}

async function sendDiscord(cfg: { url: string }, event: NotificationEvent): Promise<void> {
  const { title, body } = buildMessage(event);
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      embeds: [{ title, description: body, color: 0xf7931a }],
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 204) throw new Error(`discord returned ${res.status}`);
}

async function sendSlack(cfg: { url: string }, event: NotificationEvent): Promise<void> {
  const { title, body } = buildMessage(event);
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `*${title}*\n${body}` }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`slack returned ${res.status}`);
}

let transporter: Transporter | null = null;
function getTransporter(): Transporter {
  if (!env.smtp) throw new Error("SMTP is not configured");
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS + 5_000,
    });
  }
  return transporter;
}

function parseFromAddress(from: string): { address: string; name?: string } {
  const match = from.match(/^(.*)<([^>]+)>\s*$/);
  if (!match) return { address: from.trim() };
  const name = match[1]!.trim().replace(/^"|"$/g, "");
  return { address: match[2]!.trim(), ...(name ? { name } : {}) };
}

async function sendEmailViaCloudflare(to: string, subject: string, text: string): Promise<void> {
  const cf = env.cloudflareEmail!;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/email/sending/send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${cf.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to, from: parseFromAddress(cf.from), subject, text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    },
  );
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    errors?: { code: number; message: string }[];
    result?: { delivered?: string[]; permanent_bounces?: string[]; queued?: string[] };
  } | null;
  if (!res.ok || !json?.success) {
    throw new Error(
      `cloudflare email returned ${res.status}: ${json?.errors?.[0]?.message ?? "unknown error"}`,
    );
  }
  if (json.result?.permanent_bounces?.includes(to)) {
    throw new Error(`recipient permanently bounces: ${to}`);
  }
}

async function sendEmail(cfg: { to: string }, event: NotificationEvent): Promise<void> {
  const { title, body } = buildMessage(event);
  const text = `${body}\n\nTransaction: ${event.txHash}\nAddress: ${event.address}`;
  if (env.cloudflareEmail) {
    await sendEmailViaCloudflare(cfg.to, title, text);
    return;
  }
  await getTransporter().sendMail({
    from: env.smtp!.from,
    to: cfg.to,
    subject: title,
    text,
  });
}

export async function sendExpoPush(tokens: string[], event: NotificationEvent): Promise<void> {
  const { title, body } = buildMessage(event);
  for (let i = 0; i < tokens.length; i += 100) {
    const chunk = tokens.slice(i, i + 100);
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chunk.map((to) => ({ to, title, body, sound: "default" }))),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`expo push returned ${res.status}`);
    const json = (await res.json()) as {
      data?: { status: string; details?: { error?: string } }[];
    };
    json.data?.forEach((ticket, idx) => {
      if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
        const dead = chunk[idx];
        if (dead) removeDeadToken(dead);
      }
    });
  }
}

export async function sendToChannel(channel: ChannelRow, event: NotificationEvent): Promise<void> {
  const cfg = JSON.parse(channel.config);
  const senders: Record<ChannelType, (cfg: any, e: NotificationEvent) => Promise<void>> = {
    ntfy: sendNtfy,
    discord: sendDiscord,
    slack: sendSlack,
    email: sendEmail,
  };
  await senders[channel.type](cfg, event);
}

export function resolveRecipients(
  personalKeyId: string,
  addressId?: string,
): { channels: ChannelRow[]; tokens: PushTokenRow[] } {
  const db = getDb();
  if (addressId === undefined) {
    return {
      channels: db
        .query<ChannelRow, [string]>(
          "SELECT * FROM channels WHERE personal_key_id = ? AND enabled = 1",
        )
        .all(personalKeyId),
      tokens: db
        .query<PushTokenRow, [string]>("SELECT * FROM push_tokens WHERE personal_key_id = ?")
        .all(personalKeyId),
    };
  }
  return {
    channels: db
      .query<ChannelRow, [string, string]>(
        `SELECT * FROM channels
         WHERE personal_key_id = ? AND enabled = 1
           AND id NOT IN (SELECT channel_id FROM address_channel_mutes WHERE address_id = ?)`,
      )
      .all(personalKeyId, addressId),
    tokens: db
      .query<PushTokenRow, [string, string]>(
        `SELECT * FROM push_tokens
         WHERE personal_key_id = ?
           AND NOT EXISTS (SELECT 1 FROM address_push_mutes WHERE address_id = ?)`,
      )
      .all(personalKeyId, addressId),
  };
}

export async function notifyPersonalKey(
  personalKeyId: string,
  event: NotificationEvent,
  addressId?: string,
): Promise<void> {
  const { channels, tokens } = resolveRecipients(personalKeyId, addressId);

  const jobs: Promise<void>[] = channels.map((ch) =>
    sendToChannel(ch, event).catch((err) => {
      console.error(`[notify] ${ch.type} channel ${ch.id} failed: ${(err as Error).message}`);
    }),
  );
  if (tokens.length > 0) {
    jobs.push(
      sendExpoPush(
        tokens.map((t) => t.token),
        event,
      ).catch((err) => {
        console.error(`[notify] expo push failed: ${(err as Error).message}`);
      }),
    );
  }
  await Promise.all(jobs);
}
