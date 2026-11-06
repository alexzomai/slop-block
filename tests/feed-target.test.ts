import { describe, expect, it } from "vitest";
import { PopupController } from "../src/popup/controller";
import { DEFAULT_SETTINGS, clampTarget, normalize, setFeedTarget, type Settings } from "../src/shared/settings";
import { fromItems, loadSettings, toItems } from "../src/shared/storage";

describe("feedTarget: нормализация и миграция", () => {
  it.each([
    [5, 6], [6, 6], [12, 12], [30, 30], [31, 30], [13.6, 14], ["20", 12], [null, 12], [NaN, 12], [Infinity, 12], [-3, 6], [undefined, 12],
  ])("clampTarget(%j) = %j", (v, want) => {
    expect(clampTarget(v)).toBe(want);
    expect(normalize({ feedTarget: v }).feedTarget).toBe(want);
  });
  it("по умолчанию 12", () => {
    expect(DEFAULT_SETTINGS.feedTarget).toBe(12);
    expect(normalize(undefined).feedTarget).toBe(12);
  });
  it("старый head без поля → 12 (без записи)", () => {
    expect(fromItems({ "slop.settings": { enabled: true, order: [], mode: "blocklist" } }).feedTarget).toBe(12);
  });
  it("round-trip и размер head-item", () => {
    const s: Settings = { ...DEFAULT_SETTINGS, feedTarget: 22 };
    expect(fromItems(toItems(s)).feedTarget).toBe(22);
    const withTarget = JSON.stringify(toItems(s)["slop.settings"]).length;
    const without = JSON.stringify({ ...(toItems(s)["slop.settings"] as object), feedTarget: undefined }).length;
    expect(withTarget - without).toBeLessThanOrEqual(20);
  });
  it("loadSettings читает поле", async () => {
    const data = toItems({ ...DEFAULT_SETTINGS, feedTarget: 9 });
    const area = { get: async (k: string | string[] | null) => Object.fromEntries(Object.entries(data).filter(([key]) => k === null || [k].flat().includes(key))), set: async () => {}, remove: async () => {} };
    expect((await loadSettings(area)).feedTarget).toBe(9);
  });
  it("setFeedTarget нормализует", () => {
    expect(setFeedTarget(DEFAULT_SETTINGS, 99).feedTarget).toBe(30);
  });
});

describe("PopupController.setFeedTarget", () => {
  const setup = (fail = false) => {
    let stored: Settings = DEFAULT_SETTINGS;
    const renders: Array<{ s: Settings; msg: string }> = [];
    const c = new PopupController(
      { save: async (s) => { if (fail) throw new Error("q"); stored = s; }, render: (s, msg) => renders.push({ s, msg }) },
      DEFAULT_SETTINGS,
    );
    return { c, renders, storage: () => stored };
  };
  it("сохраняет нормализованное значение", async () => {
    const { c, storage } = setup();
    expect(await c.setFeedTarget(20)).toBe(true);
    expect(storage().feedTarget).toBe(20);
    expect(await c.setFeedTarget(99)).toBe(true);
    expect(storage().feedTarget).toBe(30);
  });
  it("нечисловой ввод: откат без записи", async () => {
    const { c, renders, storage } = setup();
    expect(await c.setFeedTarget(Number.NaN)).toBe(false);
    expect(storage().feedTarget).toBe(12);
    expect(renders.at(-1)!.s.feedTarget).toBe(12);
  });
  it("отказ записи: откат и сообщение", async () => {
    const { c, renders } = setup(true);
    expect(await c.setFeedTarget(20)).toBe(false);
    expect(c.state.feedTarget).toBe(12);
    expect(renders.at(-1)).toEqual({ s: DEFAULT_SETTINGS, msg: "save" });
  });
});
