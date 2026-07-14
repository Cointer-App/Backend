export type AppEnv = {
  Bindings: {
    ip?: string;
  };
  Variables: {
    personalKeyId: string;
  };
};

export interface NormalizedTx {
  txHash: string;
  address: string;
  amount: string;
  asset: string;
  timestamp?: number;
}

export type ChannelType = "ntfy" | "discord" | "slack" | "email";

export interface ChannelRow {
  id: string;
  personal_key_id: string;
  type: ChannelType;
  config: string;
  enabled: number;
  created_at: number;
}

export interface AddressRow {
  id: string;
  personal_key_id: string;
  chain: string;
  address: string;
  label: string | null;
  created_at: number;
}

export interface PushTokenRow {
  id: string;
  personal_key_id: string;
  token: string;
  platform: string;
  created_at: number;
}

export interface ActivityRow {
  id: number;
  personal_key_id: string;
  chain: string;
  address: string;
  tx_hash: string;
  amount: string;
  asset: string;
  created_at: number;
}

export interface NotificationEvent {
  chain: string;
  chainName: string;
  address: string;
  txHash: string;
  amount: string;
  asset: string;
  isTest?: boolean;
}
