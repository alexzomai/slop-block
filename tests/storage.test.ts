import { describe, expect, it, vi } from "vitest";
import { MAX_TAGS, MAX_TEXT, addTag, normalize, type Settings } from "../src/shared/settings";
import { fromItems, loadSettings, saveSettings, subscribeSettings, toItems, type AreaLike } from "../src/shared/storage";

/** Фейковая область с квотами sync (как у Chrome): размер item = длина ключа + JSON значения в байтах UTF-8. */
const QUOTA_BYTES_PER_ITEM = 8192, QUOTA_BYTES = 102400, MAX_ITEMS = 512;
const bytes = (k: string, v: unknown) => new TextEncoder().encode(k + JSON.stringify(v)).length;

function fakeArea(failSet = false) {
  const data: Record<string, unknown> = {};
  const area: AreaLike = {
    get: async (k) => {
      if (k === null) return { ...data };
      const keys = typeof k === "string" ? [k] : k;
      return Object.fromEntries(keys.filter((x) => x in data).map((x) => [x, data[x]]));
    },
    set: async (items) => {
      if (failSet) throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded");
      const next = { ...data, ...items };
      if (Object.keys(next).length > MAX_ITEMS) throw new Error("MAX_ITEMS");
      let total = 0;
      for (const [k, v] of Object.entries(next)) {
        const b = bytes(k, v);
        if (b > QUOTA_BYTES_PER_ITEM) throw new Error(`QUOTA_BYTES_PER_ITEM: ${k}`);
        total += b;
      }
      if (total > QUOTA_BYTES) throw new Error("QUOTA_BYTES");
      Object.assign(data, items);
    },
    remove: async (keys) => void keys.forEach((k) => delete data[k]),
  };
  return { data, area };
}

function worst(chars: (i: number) => string): Settings {
  let s: Settings = { enabled: true, tags: [], mode: "allowlist", skipSubscriptions: true, filterSearch: false, feedTarget: 12 };
  for (let i = 0; i < MAX_TAGS; i++) {
    const head = String.fromCharCode(0x41 + i); // уникальность: не равные без учёта регистра
    s = addTag(s, head + chars(i).repeat(MAX_TEXT)  .slice(0, MAX_TEXT - 1), () => crypto.randomUUID()).settings;
  }
  return s;
}

describe("storage: формат и квоты", () => {
  const cases: Array<[string, (i: number) => string]> = [
    ["кириллица", () => "я"],
    ["4-байтные emoji", () => "😀"],
    ["символы, которые JSON экранирует (\\u00XX)", () => "\u0001"],
    ["кавычки и обратные слэши", () => '"\\'],
    ["CJK (3 байта)", () => "漢"],
  ];
  for (const [name, ch] of cases) {
    it(`20 × 200 «${name}» укладывается во все квоты и читается обратно`, async () => {
      const s = worst(ch);
      expect(s.tags).toHaveLength(MAX_TAGS);
      const items = toItems(s);
      expect(Object.keys(items).length).toBeLessThanOrEqual(MAX_ITEMS);
      let total = 0;
      for (const [k, v] of Object.entries(items)) {
        const b = bytes(k, v);
        expect(b, k).toBeLessThanOrEqual(QUOTA_BYTES_PER_ITEM);
        total += b;
      }
      expect(total).toBeLessThanOrEqual(QUOTA_BYTES);
      const { area } = fakeArea();
      await saveSettings(area, s); // фейк кидает при нарушении любой квоты
      expect(await loadSettings(area)).toEqual(s);
    });
  }

  it("пусто → умолчания; save/load круг; осиротевшие теги удаляются", async () => {
    const { area, data } = fakeArea();
    expect(await loadSettings(area)).toEqual({ enabled: true, tags: [], mode: "allowlist", skipSubscriptions: true, filterSearch: false, feedTarget: 12 });
    const two = addTag(addTag({ enabled: true, tags: [], mode: "allowlist", skipSubscriptions: true, filterSearch: false, feedTarget: 12 }, "a", () => "A").settings, "b", () => "B").settings;
    await saveSettings(area, two);
    expect(Object.keys(data).sort()).toEqual(["slop.settings", "slop.tag.A", "slop.tag.B"]);
    await saveSettings(area, { ...two, enabled: false, tags: two.tags.slice(1) });
    expect(Object.keys(data).sort()).toEqual(["slop.settings", "slop.tag.B"]);
    expect((await loadSettings(area)).enabled).toBe(false);
  });

  it("повреждённые данные: нет item тега, мусорный order, небезопасный id", () => {
    expect(fromItems({ "slop.settings": { enabled: true, order: ["A", 5, "../x", "B"] }, "slop.tag.B": { text: "ok", enabled: true } }))
      .toEqual({ enabled: true, tags: [{ id: "B", text: "ok", enabled: true }], mode: "allowlist", skipSubscriptions: true, filterSearch: false, feedTarget: 12 });
    expect(fromItems({ "slop.settings": "oops" })).toEqual(normalize(undefined));
  });

  it("отказ set() — исключение, хранилище не меняется", async () => {
    const { area, data } = fakeArea(true);
    await expect(saveSettings(area, { enabled: false, tags: [], mode: "allowlist", skipSubscriptions: true, filterSearch: false, feedTarget: 12 })).rejects.toThrow();
    expect(data).toEqual({});
  });

  it("subscribe: только sync и наши ключи", () => {
    let cb!: (c: Record<string, unknown>, a: string) => void;
    const spy = vi.fn();
    subscribeSettings({ addListener: (f) => (cb = f) }, spy);
    cb({ other: {} }, "sync");
    cb({ "slop.settings": {} }, "local");
    expect(spy).not.toHaveBeenCalled();
    cb({ "slop.tag.A": {} }, "sync");
    cb({ "slop.settings": {} }, "sync");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
