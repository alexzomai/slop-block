import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_THRESHOLD, getKey, getSettings, maskKey, removeKey, saveSettings, setKey } from "../src/background/settings";
import { SECRET, fakeKV } from "./helpers/fake";

describe("settings", () => {
  it("defaults", async () => {
    const kv = fakeKV();
    expect(await getSettings(kv)).toEqual({ provider: "openrouter", model: "typesafe/jev-1.13", modelTypesafe: "jev-1.13.0", threshold: 0.7 });
    expect(DEFAULT_MODEL).toBe("typesafe/jev-1.13");
    expect(DEFAULT_THRESHOLD).toBe(0.7);
  });
  it("stores trimmed key, rejects empty", async () => {
    const kv = fakeKV();
    expect(await setKey(kv, "   ")).toBe(false);
    expect(await getKey(kv)).toBeUndefined();
    expect(await setKey(kv, `  ${SECRET}\n`)).toBe(true);
    expect(await getKey(kv)).toBe(SECRET);
    await removeKey(kv);
    expect(await getKey(kv)).toBeUndefined();
  });
  it("mask shows at most 4 chars", () => {
    const m = maskKey(SECRET);
    expect(m).toContain("9876");
    expect(m).not.toContain("SECRET");
    expect(maskKey("abc")).not.toContain("abc");
  });
  it("validates threshold and model, keeps previous on error", async () => {
    const kv = fakeKV();
    expect((await saveSettings(kv, { model: "x/y", threshold: 0.5 })).ok).toBe(true);
    for (const bad of [1.5, -0.1, NaN, "abc"]) {
      const r = await saveSettings(kv, { model: "x/y", threshold: bad as number });
      expect(r.ok).toBe(false);
    }
    expect(await saveSettings(kv, { model: "  ", threshold: 0.5 })).toEqual({ ok: false, code: "model_required" });
    expect(await saveSettings(kv, { model: "x/y", threshold: 2 })).toEqual({ ok: false, code: "threshold_range" });
    expect(await getSettings(kv)).toEqual({ provider: "openrouter", model: "x/y", modelTypesafe: "jev-1.13.0", threshold: 0.5 });
  });
});
