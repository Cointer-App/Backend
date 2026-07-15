# Cointer API

Cointer watches crypto addresses on-chain and sends a notification when they receive funds. This document covers the HTTP API.

## Basics

- Base URL: `http://localhost:3000` (or wherever the server is hosted).
- All requests and responses are JSON. Request bodies are capped at 100 KB.
- Errors are always `{ "error": "<message>" }`. A malformed JSON body returns `400 { "error": "Invalid JSON body" }`.
- Timestamps (`createdAt`, `priceAsOf`, activity times) are unix seconds.
- Amounts are decimal strings (e.g. `"0.00123456"`). Fiat values are numbers rounded to 2 decimals.
- Unknown paths return `404 { "error": "Not found" }`. Unhandled errors return `500 { "error": "Internal server error" }`.

## Authentication

There are no accounts. Mint a personal key with `POST /personal` and send it on every authed request:

```
Authorization: Bearer ck_<43 chars>
```

The key is shown once. Only its hash is stored, so it can't be recovered. If you lose it, mint a new one. All your data (addresses, channels, push tokens, activity) is tied to the key.

Auth failures return 401 with `Missing bearer token` (no or bad header) or `Invalid personal key` (unknown or malformed key).

Public routes (no key needed): `POST /personal`, `GET /chains`, `GET /stats/wallets`, `GET /capabilities`, `GET /health`. Everything else needs the bearer key.

## Rate limits

| Scope                              | Limit        |
| ---------------------------------- | ------------ |
| All requests, per IP               | 120 / minute |
| `POST /personal`, per IP           | 5 / hour     |
| Authed requests, per key           | 60 / minute  |
| `POST /channels/:id/test`, per key | 10 / hour    |

Going over any of these returns `429 { "error": "Too many requests" }` with a `Retry-After` header (seconds).

---

## Personal key

### POST /personal

Mints a new personal key. No auth, no body.

**201**

```json
{ "personalKey": "ck_dGhpcyBpcyBub3QgYSByZWFsIGtleSBhdCBhbGw" }
```

Save it. It is never shown again.

### GET /personal

Auth required. Returns the full account config. Never includes the key itself.

**200**

```json
{
  "createdAt": 1712345678,
  "addresses": [
    {
      "id": "uuid",
      "chain": "bitcoin",
      "address": "bc1q...",
      "label": "Cold wallet",
      "createdAt": 1712345678,
      "notifications": { "pushMuted": false, "mutedChannelIds": [] }
    }
  ],
  "channels": [
    {
      "id": "uuid",
      "type": "discord",
      "enabled": true,
      "config": { "url": "https://discord.com/…AbCd" },
      "createdAt": 1712345678
    }
  ],
  "pushTokens": [
    { "id": "uuid", "token": "ExponentPushToken[...]", "platform": "ios", "createdAt": 1712345678 }
  ]
}
```

### POST /personal/rotate

Auth required. No body. Issues a replacement key for the same account. The old key stops working immediately.

**200** `{ "personalKey": "ck_..." }`

### DELETE /personal

Auth required. No body. Deletes the key and everything under it.

**200** `{ "deleted": true }`

---

## Addresses

All routes require auth.

### GET /addresses

Lists the addresses you're watching.

**200**

```json
{
  "addresses": [
    {
      "id": "uuid",
      "chain": "bitcoin",
      "address": "bc1q...",
      "label": "Cold wallet",
      "createdAt": 1712345678
    }
  ]
}
```

### POST /addresses

Starts watching an address. Existing on-chain history is seeded in the background so you don't get notified for old transactions.

Body:

| Field     | Type   | Required | Notes                                                      |
| --------- | ------ | -------- | ---------------------------------------------------------- |
| `chain`   | string | yes      | A chain id from `GET /chains` (e.g. `bitcoin`, `ethereum`) |
| `address` | string | yes      | Validated and normalized per chain                         |
| `label`   | string | no       | Max 100 chars                                              |

**201** `{ "id": "uuid", "chain": "bitcoin", "address": "bc1q...", "label": "Cold wallet", "createdAt": 1712345678 }`

**400** unsupported chain, invalid address, bad label, duplicate (`You are already watching this address`), or `Address limit reached (10)`.

### PATCH /addresses/:addressId

Renames a watched address.

Body:

| Field   | Type   | Required | Notes                                     |
| ------- | ------ | -------- | ----------------------------------------- |
| `label` | string | no       | Max 100 chars. Omit or `null` to clear it |

**200** `{ "id": "uuid", "chain": "bitcoin", "address": "bc1q...", "label": "New name", "createdAt": 1712345678 }`
**400** bad label.
**404** `{ "error": "Address not found" }`

### GET /addresses/:addressId/notifications

Notification settings for one address: push plus every channel you have, each flagged with whether it's enabled for this address.

**200**

```json
{
  "push": { "enabled": true },
  "channels": [
    {
      "id": "uuid",
      "type": "ntfy",
      "enabled": true,
      "config": { "server": "https://ntfy.sh", "topic": "my-topic" },
      "createdAt": 1712345678,
      "enabledForWallet": false
    }
  ]
}
```

`enabled` is the channel's global switch. `enabledForWallet` is the per-address mute.

**404** `{ "error": "Address not found" }`

### PATCH /addresses/:addressId/notifications

Updates the per-address settings. `false` mutes, `true` unmutes.

Body (both fields optional):

| Field      | Type    | Notes                             |
| ---------- | ------- | --------------------------------- |
| `push`     | boolean | Mute/unmute push for this address |
| `channels` | object  | Map of channel id to boolean      |

Example: `{ "push": false, "channels": { "some-channel-id": true } }`

**200** updated settings, same shape as GET.
**400** non-boolean values or `Unknown channel id: <id>`.
**404** `{ "error": "Address not found" }`

### DELETE /addresses/:addressId

Stops watching the address.

**200** `{ "deleted": true }`
**404** `{ "error": "Address not found" }`

---

## Channels

Notification channels besides push. All routes require auth. Secret config values (webhook URLs) are only ever returned as previews, e.g. `"https://discord.com/…AbCd"`.

### GET /channels

**200**

```json
{
  "channels": [
    {
      "id": "uuid",
      "type": "slack",
      "enabled": true,
      "config": { "url": "https://hooks.slack.com/…AbCd" },
      "createdAt": 1712345678
    }
  ]
}
```

### POST /channels

Creates a channel. Body: `type` (string) and `config` (object, validated per type):

| `type`    | `config`                                            | Notes                                                                                         |
| --------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ntfy`    | `{ "topic": "...", "server": "https://..." }`       | Topic: letters/digits/`-`/`_`, max 64. `server` is optional and defaults to `https://ntfy.sh` |
| `discord` | `{ "url": "https://discord.com/api/webhooks/..." }` | Must be a Discord webhook URL                                                                 |
| `slack`   | `{ "url": "https://hooks.slack.com/..." }`          | Must be a Slack webhook URL                                                                   |
| `email`   | `{ "to": "you@example.com" }`                       | Only available if the server has email configured (check `GET /capabilities`)                 |

**201** the created channel (preview shape, as in GET).
**400** bad type/config, private/local URLs rejected, or `Channel limit reached (10)`.

### PATCH /channels/:channelId

Body (both optional): `enabled` (boolean) and/or `config` (object, full replacement, validated against the channel's type; you can't change the type).

**200** the updated channel.
**400** `enabled must be a boolean` or config validation errors.
**404** `{ "error": "Channel not found" }`

### DELETE /channels/:channelId

**200** `{ "deleted": true }`
**404** `{ "error": "Channel not found" }`

### POST /channels/:channelId/test

Sends a sample notification through the channel. No body.

**200** `{ "sent": true }`, or `{ "sent": false, "error": "<why>" }` if delivery failed. Send failures are 200 on purpose so proxies don't replace the error body.
**404** `{ "error": "Channel not found" }`
**429** test-send rate limit exceeded.

---

## Push tokens

Expo push tokens for the mobile app. All routes require auth.

### POST /push-token

Body:

| Field      | Type   | Required | Notes                                            |
| ---------- | ------ | -------- | ------------------------------------------------ |
| `token`    | string | yes      | `ExponentPushToken[...]` or `ExpoPushToken[...]` |
| `platform` | string | yes      | `ios` or `android`                               |

**201** `{ "id": "uuid", "token": "ExponentPushToken[...]", "platform": "ios" }`. Registering the same token twice returns the existing record.

**400** invalid token format, bad platform, or `Push token limit reached (10)`.

### DELETE /push-token/:tokenId

**200** `{ "deleted": true }`
**404** `{ "error": "Push token not found" }`

---

## Activity

Incoming transfers seen on your watched addresses. Auth required.

### GET /activity

Query params (both optional):

| Param    | Notes                               |
| -------- | ----------------------------------- |
| `limit`  | Page size, default 25, max 100      |
| `cursor` | `nextCursor` from the previous page |

**200** newest first:

```json
{
  "items": [
    {
      "id": 42,
      "chain": "bitcoin",
      "address": "bc1q...",
      "txHash": "abc...",
      "amount": "0.00123456",
      "asset": "BTC",
      "createdAt": 1712345678
    }
  ],
  "nextCursor": 41
}
```

`nextCursor` is `null` on the last page.

### GET /activity/value

Same as `GET /activity` (same `limit`/`cursor` params) but each item includes a fiat value, plus a total across all retained activity for the key. The total is the same on every page.

**200**

```json
{
  "currency": "usd",
  "priceAsOf": 1712345678,
  "total": 1234.56,
  "unpricedCount": 0,
  "items": [
    {
      "id": 42,
      "chain": "bitcoin",
      "address": "bc1q...",
      "txHash": "abc...",
      "amount": "0.00123456",
      "asset": "BTC",
      "createdAt": 1712345678,
      "fiatValue": 12.34
    }
  ],
  "nextCursor": null
}
```

Items with no fresh cached price get `fiatValue: null`, are left out of `total`, and are counted in `unpricedCount`. `priceAsOf` is `null` when no price has been fetched yet.

### GET /activity/summary

Aggregates your retained activity (retention period is in `GET /capabilities`). No query params.

**200**

```json
{
  "currency": "usd",
  "priceAsOf": 1712345678,
  "windows": {
    "24h": { "count": 3, "fiatTotal": 123.45, "unpricedCount": 0 },
    "7d": { "count": 9, "fiatTotal": 512.0, "unpricedCount": 1 },
    "30d": { "count": 20, "fiatTotal": 1490.9, "unpricedCount": 2 }
  },
  "assets": [
    { "chain": "bitcoin", "asset": "BTC", "count": 5, "amount": "0.523", "fiatValue": 52300.0 }
  ]
}
```

`windows` buckets deposits by age. Items with no fresh price are left out of `fiatTotal` and counted in `unpricedCount`. `assets` totals every retained row per asset, sorted by fiat value descending (`fiatValue: null` when unpriced).

### GET /activity/month

Totals your incoming transfers for one calendar month (UTC). Useful for tracking a monthly goal.

Query params:

| Param   | Notes                                                  |
| ------- | ------------------------------------------------------ |
| `month` | `YYYY-MM`, optional. Defaults to the current UTC month |

**200**

```json
{
  "month": "2026-07",
  "currency": "usd",
  "priceAsOf": 1712345678,
  "count": 12,
  "fiatTotal": 843.21,
  "unpricedCount": 0,
  "assets": [
    { "chain": "bitcoin", "asset": "BTC", "count": 8, "amount": "0.0123", "fiatValue": 743.21 }
  ]
}
```

Deposits are priced at current cached prices, not the price at time of receipt. Items with no fresh price are left out of `fiatTotal` and counted in `unpricedCount` (`fiatValue: null` for fully unpriced assets). Only retained activity is counted (see `activityRetentionDays` in `GET /capabilities`), so months older than the retention window come back empty or partial.

**400** `{ "error": "month must be in YYYY-MM format" }`

---

## Public / meta

No auth on any of these.

### GET /chains

Chains supported by the server. Use the `id` values for `POST /addresses`.

**200** `{ "chains": [ { "id": "bitcoin", "name": "Bitcoin", "asset": "BTC" } ] }`

### GET /stats/wallets

Number of distinct wallets watched across all keys.

**200** `{ "watchedWallets": 123 }`

### GET /capabilities

Server configuration: whether the `email` channel type is available, the fiat currency, and the per-key limits.

**200**

```json
{
  "email": false,
  "currency": "usd",
  "limits": {
    "maxAddressesPerKey": 10,
    "maxChannelsPerKey": 10,
    "maxPushTokensPerKey": 10,
    "activityRetentionDays": 90
  }
}
```

### GET /health

**200** `{ "status": "ok" }`
