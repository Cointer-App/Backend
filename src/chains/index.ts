import { env } from "../config/env";
import { bitcoin } from "./bitcoin";
import { ethereum } from "./ethereum";

export interface ChainAdapter {
  id: string;
  displayName: string;
  asset: string;
  validate(address: string): boolean;
  normalize(address: string): string;
}

const registry: Record<string, ChainAdapter> = {
  [bitcoin.id]: bitcoin,
  [ethereum.id]: ethereum,
};

export function getEnabledChains(): ChainAdapter[] {
  return env.enabledChains
    .map((id) => registry[id])
    .filter((a): a is ChainAdapter => a !== undefined);
}

export function getChain(id: string): ChainAdapter | null {
  const adapter = registry[id];
  if (!adapter || !env.enabledChains.includes(id)) return null;
  return adapter;
}

for (const id of env.enabledChains) {
  if (!registry[id]) {
    throw new Error(`Chain "${id}" is in ENABLED_CHAINS but has no adapter in src/chains`);
  }
}
