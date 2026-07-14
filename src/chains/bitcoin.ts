import type { ChainAdapter } from "./index";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((c, i) => [c, i]));

function base58Decode(input: string): Uint8Array | null {
  if (input.length === 0 || input.length > 90) return null;
  const bytes: number[] = [0];
  for (const char of input) {
    const value = BASE58_MAP.get(char);
    if (value === undefined) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of input) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(new Bun.CryptoHasher("sha256").update(data).digest());
}

function isValidBase58Check(address: string, versions: number[]): boolean {
  const decoded = base58Decode(address);
  if (!decoded || decoded.length !== 25) return false;
  if (!versions.includes(decoded[0]!)) return false;
  const payload = decoded.slice(0, 21);
  const checksum = decoded.slice(21);
  const hash = sha256(sha256(payload));
  return checksum.every((b, i) => b === hash[i]);
}

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_MAP = new Map([...BECH32_CHARSET].map((c, i) => [c, i]));
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i]!;
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function bech32Decode(
  address: string,
): { hrp: string; data: number[]; spec: "bech32" | "bech32m" } | null {
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return null;
  const addr = address.toLowerCase();
  const sep = addr.lastIndexOf("1");
  if (sep < 1 || sep + 7 > addr.length || addr.length > 90) return null;
  const hrp = addr.slice(0, sep);
  const data: number[] = [];
  for (const char of addr.slice(sep + 1)) {
    const v = BECH32_MAP.get(char);
    if (v === undefined) return null;
    data.push(v);
  }
  const check = bech32Polymod([...hrpExpand(hrp), ...data]);
  if (check === 1) return { hrp, data: data.slice(0, -6), spec: "bech32" };
  if (check === BECH32M_CONST) return { hrp, data: data.slice(0, -6), spec: "bech32m" };
  return null;
}

function convertBits(data: number[], from: number, to: number): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) return null;
  return out;
}

function isValidSegwit(address: string): boolean {
  const decoded = bech32Decode(address);
  if (!decoded || decoded.hrp !== "bc") return false;
  const [version, ...rest] = decoded.data;
  if (version === undefined || version > 16) return false;
  if (version === 0 && decoded.spec !== "bech32") return false;
  if (version > 0 && decoded.spec !== "bech32m") return false;
  const program = convertBits(rest, 5, 8);
  if (!program || program.length < 2 || program.length > 40) return false;
  if (version === 0 && program.length !== 20 && program.length !== 32) return false;
  return true;
}

function validate(address: string): boolean {
  if (typeof address !== "string" || address.length < 26 || address.length > 90) return false;
  if (address.startsWith("1") || address.startsWith("3")) {
    return isValidBase58Check(address, [0x00, 0x05]);
  }
  if (address.toLowerCase().startsWith("bc1")) {
    return isValidSegwit(address);
  }
  return false;
}

function normalize(address: string): string {
  return address.toLowerCase().startsWith("bc1") ? address.toLowerCase() : address;
}

export const bitcoin: ChainAdapter = {
  id: "bitcoin",
  displayName: "Bitcoin",
  asset: "BTC",
  validate,
  normalize,
};
