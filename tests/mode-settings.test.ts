import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, effectiveState, normalize, setMode, setSkipSubscriptions, type Settings } from "../src/shared/settings";
import { fromItems, toItems } from "../src/shared/storage";

const base = (o: Partial<Settings> = {}): Settings => ({ enabled: true, tags: [{ id: "a", text: "IT", enabled: true }], mode: "allowlist", skipSubscriptions: true, filterSearch: false, feedTarget: 12, ...o });

describe("mode / skipSubscriptions: миграция и нормализация", () => {
  it("пустое хранилище → allowlist, skip=true", () => {
    expect(normalize(undefined)).toEqual({ enabled: true, tags: [], mode: "allowlist", skipSubscriptions: true, filterSearch: false, feedTarget: 12 });
    expect(DEFAULT_SETTINGS.mode).toBe("allowlist");
    expect(DEFAULT_SETTINGS.skipSubscriptions).toBe(true);
  });
  it("старый head без полей → allowlist / true", () => {
    const s = fromItems({ "slop.settings": { enabled: false, order: [] } });
    expect(s.mode).toBe("allowlist");
    expect(s.skipSubscriptions).toBe(true);
    expect(s.enabled).toBe(false);
  });
  it.each(["foo", 5, null, {}, true])("мусор в mode (%j) → allowlist", (v) => {
    expect(normalize({ mode: v }).mode).toBe("allowlist");
  });
  it.each(["no", 0, null, "false"])("мусор в skipSubscriptions (%j) → true", (v) => {
    expect(normalize({ skipSubscriptions: v, feedTarget: 12 }).skipSubscriptions).toBe(true);
  });
  it("round-trip через item'ы", () => {
    const s = base({ mode: "blocklist", skipSubscriptions: false, filterSearch: false, feedTarget: 12 });
    expect(fromItems(toItems(s))).toEqual(s);
  });
  it("setMode / setSkipSubscriptions", () => {
    expect(setMode(base(), "blocklist").mode).toBe("blocklist");
    expect(setSkipSubscriptions(base(), false).skipSubscriptions).toBe(false);
  });
});

describe("effectiveState", () => {
  it("активен: включён, есть тег", () => {
    const e = effectiveState(base(), { onSubscriptions: false, keyMissing: false });
    expect(e).toEqual({ active: true, mode: "allowlist", tags: [{ id: "a", text: "IT" }] });
  });
  it.each([
    ["фильтр выключен", base({ enabled: false }), { onSubscriptions: false, keyMissing: false }],
    ["нет тегов", base({ tags: [] }), { onSubscriptions: false, keyMissing: false }],
    ["все теги выключены", base({ tags: [{ id: "a", text: "x", enabled: false }] }), { onSubscriptions: false, keyMissing: false }],
    ["подписки + skip", base(), { onSubscriptions: true, keyMissing: false }],
    ["нет ключа", base(), { onSubscriptions: false, keyMissing: true }],
  ])("неактивен: %s", (_n, s, ctx) => {
    const e = effectiveState(s, ctx);
    expect(e.active).toBe(false);
  });
  it("подписки без skip → активен", () => {
    expect(effectiveState(base({ skipSubscriptions: false, filterSearch: false, feedTarget: 12 }), { onSubscriptions: true, keyMissing: false }).active).toBe(true);
  });
  it("blocklist тоже обходит подписки", () => {
    expect(effectiveState(base({ mode: "blocklist" }), { onSubscriptions: true, keyMissing: false }).active).toBe(false);
  });
});
