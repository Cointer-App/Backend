import { describe, expect, test } from "bun:test";
import { hashPersonalKey, PERSONAL_KEY_RE } from "../middleware/auth";
import { generatePersonalKey } from "../services/personalService";

describe("personal key generation", () => {
  test("matches the documented format", () => {
    for (let i = 0; i < 20; i++) {
      expect(generatePersonalKey()).toMatch(PERSONAL_KEY_RE);
    }
  });

  test("keys are unique", () => {
    const keys = new Set(Array.from({ length: 1000 }, generatePersonalKey));
    expect(keys.size).toBe(1000);
  });

  test("hash is deterministic sha256 hex, not the key itself", () => {
    const key = generatePersonalKey();
    const hash = hashPersonalKey(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashPersonalKey(key));
    expect(hash).not.toContain(key);
  });
});
