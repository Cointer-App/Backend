import type { ChainAdapter } from "./index";

function validate(address: string): boolean {
  return typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address);
}

function normalize(address: string): string {
  return address.toLowerCase();
}

export const ethereum: ChainAdapter = {
  id: "ethereum",
  displayName: "Ethereum",
  asset: "ETH",
  validate,
  normalize,
};
