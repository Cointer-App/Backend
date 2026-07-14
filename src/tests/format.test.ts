import { describe, expect, test } from "bun:test";
import { formatUnits } from "../ingest/format";

describe("formatUnits", () => {
  test("zero", () => {
    expect(formatUnits(0n, 8)).toBe("0");
  });

  test("one satoshi", () => {
    expect(formatUnits(1n, 8)).toBe("0.00000001");
  });

  test("trims trailing zeros", () => {
    expect(formatUnits(500_000n, 8)).toBe("0.005");
    expect(formatUnits(150_000_000n, 8)).toBe("1.5");
  });

  test("exact whole values have no fraction", () => {
    expect(formatUnits(100_000_000n, 8)).toBe("1");
    expect(formatUnits(2n * 10n ** 18n, 18)).toBe("2");
  });

  test("one wei keeps all 18 decimals", () => {
    expect(formatUnits(1n, 18)).toBe("0.000000000000000001");
  });

  test("large values never use exponent notation", () => {
    expect(formatUnits(21_000_000n * 10n ** 8n, 8)).toBe("21000000");
    expect(formatUnits(123_456_789_012_345_678_901n, 18)).toBe("123.456789012345678901");
  });

  test("zero decimals", () => {
    expect(formatUnits(42n, 0)).toBe("42");
  });
});
