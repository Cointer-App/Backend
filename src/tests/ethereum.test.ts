import { describe, expect, test } from "bun:test";
import { ethereum } from "../chains/ethereum";

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

describe("ethereum address validation", () => {
  test("accepts a checksummed address", () => {
    expect(ethereum.validate(VITALIK)).toBe(true);
  });

  test("accepts all-lowercase and all-uppercase hex", () => {
    expect(ethereum.validate(VITALIK.toLowerCase())).toBe(true);
    expect(ethereum.validate(`0x${VITALIK.slice(2).toUpperCase()}`)).toBe(true);
  });

  test("rejects wrong length", () => {
    expect(ethereum.validate(VITALIK.slice(0, -1))).toBe(false);
    expect(ethereum.validate(`${VITALIK}0`)).toBe(false);
  });

  test("rejects missing 0x prefix, non-hex, garbage and empty", () => {
    expect(ethereum.validate(VITALIK.slice(2))).toBe(false);
    expect(ethereum.validate("0xZZdA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(false);
    expect(ethereum.validate("not-an-address")).toBe(false);
    expect(ethereum.validate("")).toBe(false);
  });

  test("normalizes to lowercase", () => {
    expect(ethereum.normalize(VITALIK)).toBe(VITALIK.toLowerCase());
  });
});
