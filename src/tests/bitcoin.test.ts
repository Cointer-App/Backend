import { describe, expect, test } from "bun:test";
import { bitcoin } from "../chains/bitcoin";

describe("bitcoin address validation", () => {
  test("accepts valid P2PKH (legacy)", () => {
    expect(bitcoin.validate("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe(true);
  });

  test("accepts valid P2SH", () => {
    expect(bitcoin.validate("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).toBe(true);
  });

  test("accepts valid bech32 SegWit v0 (BIP-173 vector)", () => {
    expect(bitcoin.validate("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe(true);
    expect(bitcoin.validate("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4")).toBe(true);
  });

  test("accepts valid bech32m Taproot", () => {
    expect(bitcoin.validate("bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297")).toBe(
      true,
    );
  });

  test("rejects bad base58 checksum", () => {
    expect(bitcoin.validate("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb")).toBe(false);
  });

  test("rejects bad bech32 checksum", () => {
    expect(bitcoin.validate("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5")).toBe(false);
  });

  test("rejects taproot with bech32 (not bech32m) checksum", () => {
    expect(bitcoin.validate("bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4")).toBe(
      false,
    );
  });

  test("rejects testnet, mixed case, garbage and empty", () => {
    expect(bitcoin.validate("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")).toBe(false);
    expect(bitcoin.validate("bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe(false);
    expect(bitcoin.validate("not-an-address")).toBe(false);
    expect(bitcoin.validate("")).toBe(false);
    expect(bitcoin.validate("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfN0")).toBe(false);
  });

  test("normalizes bech32 to lowercase, leaves base58 untouched", () => {
    expect(bitcoin.normalize("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4")).toBe(
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    );
    expect(bitcoin.normalize("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe(
      "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    );
  });
});
