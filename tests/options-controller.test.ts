import { describe, expect, it } from "vitest";
import { loadView, onRemoveKey, onSaveKey, onSaveSettings } from "../src/options/controller";
import { SECRET, fakeKV } from "./helpers/fake";

describe("options controller", () => {
  it("empty key save does nothing", async () => {
    const kv = fakeKV();
    const r = await onSaveKey(kv, "  ");
    expect(r.ok).toBe(false);
    expect(kv.data.openrouterKey).toBeUndefined();
  });
  it("save -> masked status, never full key in view", async () => {
    const kv = fakeKV();
    const r = await onSaveKey(kv, SECRET);
    expect(r.ok).toBe(true);
    const v = await loadView(kv);
    expect(v.keySet).toBe(true);
    expect(JSON.stringify({ r, v })).not.toContain("SECRETSECRET");
    expect(v.keyMask).toContain("9876");
  });
  it("remove key", async () => {
    const kv = fakeKV({ openrouterKey: SECRET });
    await onRemoveKey(kv);
    expect((await loadView(kv)).keySet).toBe(false);
  });
  it("settings validation message", async () => {
    const kv = fakeKV();
    const bad = await onSaveSettings(kv, "typesafe/jev-1.13", "1.5");
    expect(bad).toEqual({ ok: false, key: "err_threshold_range" });
    expect(await onSaveSettings(kv, "  ", "0.5")).toEqual({ ok: false, key: "err_model_required" });
    expect(await onSaveKey(kv, " ")).toEqual({ ok: false, key: "msg_key_required" });
    const good = await onSaveSettings(kv, "typesafe/jev-1.14", "0.8");
    expect(good.ok).toBe(true);
    expect(await loadView(kv)).toMatchObject({ model: "typesafe/jev-1.14", threshold: 0.8 });
  });
});
