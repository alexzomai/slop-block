import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS, MAX_TAGS, MAX_TEXT, activeTags, addTag, normalize, removeTag, setEnabled, toggleTag,
} from "../src/shared/settings";

let n = 0;
const id = () => `id${++n}`;

describe("normalize", () => {
  it("пустое хранилище → значения по умолчанию", () => {
    expect(normalize(undefined)).toEqual({ enabled: true, tags: [], mode: "allowlist", skipSubscriptions: true, filterSearch: false, feedTarget: 12 });
    expect(normalize(null)).toEqual(DEFAULT_SETTINGS);
  });
  it("мусор отбрасывается", () => {
    expect(normalize({ enabled: "yes", tags: "x" })).toEqual({ enabled: true, tags: [], mode: "allowlist", skipSubscriptions: true, filterSearch: false, feedTarget: 12 });
    const s = normalize({ enabled: false, tags: [{ id: "a", text: " ok ", enabled: true }, { id: 1, text: "x" }, { id: "b" }, null, { id: "c", text: "", enabled: true }, { id: "a", text: "dup" }] });
    expect(s).toEqual({ enabled: false, tags: [{ id: "a", text: "ok", enabled: true }], mode: "allowlist", skipSubscriptions: true, filterSearch: false, feedTarget: 12 });
  });
  it("не больше MAX_TAGS и обрезка текста", () => {
    const tags = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, text: "x".repeat(300), enabled: true }));
    const s = normalize({ enabled: true, tags });
    expect(s.tags).toHaveLength(MAX_TAGS);
    expect(s.tags[0]!.text).toHaveLength(MAX_TEXT);
  });
});

describe("addTag", () => {
  it("добавляет и обрезает пробелы", () => {
    const r = addTag(DEFAULT_SETTINGS, "  кликбейт про похудение ", id);
    expect(r.error).toBeUndefined();
    expect(r.settings.tags).toHaveLength(1);
    expect(r.settings.tags[0]).toMatchObject({ text: "кликбейт про похудение", enabled: true });
  });
  it("пустой тег", () => {
    expect(addTag(DEFAULT_SETTINGS, "   ", id).error).toBe("empty");
  });
  it("дубликат без учёта регистра", () => {
    const a = addTag(DEFAULT_SETTINGS, "Кликбейт", id).settings;
    const r = addTag(a, "кликбейт", id);
    expect(r.error).toBe("duplicate");
    expect(r.settings.tags).toHaveLength(1);
  });
  it("лимиты", () => {
    expect(addTag(DEFAULT_SETTINGS, "x".repeat(MAX_TEXT + 1), id).error).toBe("too_long");
    let s = DEFAULT_SETTINGS;
    for (let i = 0; i < MAX_TAGS; i++) s = addTag(s, `t${i}`, id).settings;
    expect(addTag(s, "ещё", id).error).toBe("limit");
  });
});

describe("операции", () => {
  const s = addTag(DEFAULT_SETTINGS, "a", () => "A").settings;
  it("remove/toggle/setEnabled", () => {
    expect(toggleTag(s, "A").tags[0]!.enabled).toBe(false);
    expect(removeTag(s, "A").tags).toEqual([]);
    expect(setEnabled(s, false).enabled).toBe(false);
    expect(s.tags[0]!.enabled).toBe(true); // иммутабельность
  });
  it("activeTags: только включённые, только {id,text}", () => {
    const two = addTag(s, "b", () => "B").settings;
    expect(activeTags(toggleTag(two, "A"))).toEqual([{ id: "B", text: "b" }]);
    expect(activeTags(setEnabled(two, false))).toEqual([]);
  });
});
