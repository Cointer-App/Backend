import { getDb, now } from "../db/client";
import { listChannels } from "./channelService";
import { ValidationError } from "./pushTokenService";

export interface AddressNotificationSettings {
  push: { enabled: boolean };
  channels: (ReturnType<typeof listChannels>[number] & { enabledForWallet: boolean })[];
}

function ownsAddress(personalKeyId: string, addressId: string): boolean {
  return (
    getDb()
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM addresses WHERE id = ? AND personal_key_id = ?",
      )
      .get(addressId, personalKeyId) != null
  );
}

export function getAddressNotificationSettings(
  personalKeyId: string,
  addressId: string,
): AddressNotificationSettings | null {
  if (!ownsAddress(personalKeyId, addressId)) return null;
  const db = getDb();

  const muted = new Set(
    db
      .query<{ channel_id: string }, [string]>(
        "SELECT channel_id FROM address_channel_mutes WHERE address_id = ?",
      )
      .all(addressId)
      .map((r) => r.channel_id),
  );
  const pushMuted =
    db
      .query<{ address_id: string }, [string]>(
        "SELECT address_id FROM address_push_mutes WHERE address_id = ?",
      )
      .get(addressId) != null;

  return {
    push: { enabled: !pushMuted },
    channels: listChannels(personalKeyId).map((ch) => ({
      ...ch,
      enabledForWallet: !muted.has(ch.id),
    })),
  };
}

export function updateAddressNotificationSettings(
  personalKeyId: string,
  addressId: string,
  patch: { push?: unknown; channels?: unknown },
): AddressNotificationSettings | null {
  if (!ownsAddress(personalKeyId, addressId)) return null;
  const db = getDb();

  if (patch.push !== undefined && typeof patch.push !== "boolean") {
    throw new ValidationError("push must be a boolean");
  }

  const channelPatch: [string, boolean][] = [];
  if (patch.channels !== undefined) {
    if (
      typeof patch.channels !== "object" ||
      patch.channels === null ||
      Array.isArray(patch.channels)
    ) {
      throw new ValidationError("channels must be an object mapping channel id to boolean");
    }
    const owned = new Set(
      db
        .query<{ id: string }, [string]>("SELECT id FROM channels WHERE personal_key_id = ?")
        .all(personalKeyId)
        .map((r) => r.id),
    );
    for (const [channelId, enabled] of Object.entries(patch.channels)) {
      if (!owned.has(channelId)) throw new ValidationError(`Unknown channel id: ${channelId}`);
      if (typeof enabled !== "boolean")
        throw new ValidationError("channel values must be booleans");
      channelPatch.push([channelId, enabled]);
    }
  }

  db.transaction(() => {
    if (patch.push === false) {
      db.run("INSERT OR IGNORE INTO address_push_mutes (address_id, created_at) VALUES (?, ?)", [
        addressId,
        now(),
      ]);
    } else if (patch.push === true) {
      db.run("DELETE FROM address_push_mutes WHERE address_id = ?", [addressId]);
    }
    for (const [channelId, enabled] of channelPatch) {
      if (enabled) {
        db.run("DELETE FROM address_channel_mutes WHERE address_id = ? AND channel_id = ?", [
          addressId,
          channelId,
        ]);
      } else {
        db.run(
          "INSERT OR IGNORE INTO address_channel_mutes (address_id, channel_id, created_at) VALUES (?, ?, ?)",
          [addressId, channelId, now()],
        );
      }
    }
  })();

  return getAddressNotificationSettings(personalKeyId, addressId);
}

export function listMutesForKey(
  personalKeyId: string,
): Map<string, { pushMuted: boolean; mutedChannelIds: string[] }> {
  const db = getDb();
  const result = new Map<string, { pushMuted: boolean; mutedChannelIds: string[] }>();
  const entry = (addressId: string) => {
    let e = result.get(addressId);
    if (!e) {
      e = { pushMuted: false, mutedChannelIds: [] };
      result.set(addressId, e);
    }
    return e;
  };

  const channelMutes = db
    .query<{ address_id: string; channel_id: string }, [string]>(
      `SELECT m.address_id, m.channel_id FROM address_channel_mutes m
       JOIN addresses a ON a.id = m.address_id WHERE a.personal_key_id = ?`,
    )
    .all(personalKeyId);
  for (const row of channelMutes) entry(row.address_id).mutedChannelIds.push(row.channel_id);

  const pushMutes = db
    .query<{ address_id: string }, [string]>(
      `SELECT p.address_id FROM address_push_mutes p
       JOIN addresses a ON a.id = p.address_id WHERE a.personal_key_id = ?`,
    )
    .all(personalKeyId);
  for (const row of pushMutes) entry(row.address_id).pushMuted = true;

  return result;
}
