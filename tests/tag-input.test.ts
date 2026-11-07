import { describe, expect, it } from "vitest";
import { clampHeight, counterView, isSubmitKey } from "../src/popup/input";
import { MAX_TEXT, addTag, normalizeTagText, type Settings } from "../src/shared/settings";

const key = (o: Partial<{ key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing: boolean }> = {}) => ({
  key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, ...o,
});

describe("клавиши поля тега", () => {
  it("Enter добавляет", () => expect(isSubmitKey(key())).toBe(true));
  it("Shift+Enter — перенос, не добавляет", () => expect(isSubmitKey(key({ shiftKey: true }))).toBe(false));
  it("Enter в IME-композиции не добавляет", () => expect(isSubmitKey(key({ isComposing: true }))).toBe(false));
  it.each([["ctrlKey"], ["altKey"], ["metaKey"]] as const)("Enter с %s не добавляет", (m) => expect(isSubmitKey(key({ [m]: true }))).toBe(false));
  it("другие клавиши не добавляют", () => expect(isSubmitKey(key({ key: "a" }))).toBe(false));
});

describe("нормализация тега", () => {
  it("переносы и серии пробелов схлопываются в один пробел", () => {
    expect(normalizeTagText("a\nb\n\n c")).toBe("a b c");
    expect(normalizeTagText("  a \r\n\tb  ")).toBe("a b");
  });
  const S0: Settings = { enabled: true, tags: [], mode: "allowlist", skipSubscriptions: true, filterSearch: false, feedTarget: 12 };
  it("addTag сохраняет тег одной строкой", () => {
    const r = addTag(S0, "a\nb\n\n c", () => "id1");
    expect(r.error).toBeUndefined();
    expect(r.settings.tags[0]!.text).toBe("a b c");
  });
  it("дубликат ищется по нормализованному тексту", () => {
    const first = addTag(S0, "a b", () => "id1").settings;
    expect(addTag(first, "A\nB", () => "id2").error).toBe("duplicate");
  });
  it("лимит 200 считается после схлопывания", () => {
    expect(addTag(S0, "я\n\n".repeat(100), () => "i").error).toBeUndefined();
    expect(addTag(S0, "я".repeat(201), () => "i").error).toBe("too_long");
  });
});

describe("счётчик", () => {
  it("n считается по нормализованному значению", () => {
    expect(counterView("a\n\nb", MAX_TEXT)).toEqual({ n: 3, atLimit: false });
  });
  it("у лимита подсвечивается", () => {
    expect(counterView("x".repeat(199), MAX_TEXT).atLimit).toBe(false);
    expect(counterView("x".repeat(200), MAX_TEXT)).toEqual({ n: 200, atLimit: true });
  });
  it("не превышает лимит даже при длинной вставке", () => {
    expect(counterView("x".repeat(500), MAX_TEXT)).toEqual({ n: 200, atLimit: true });
  });
  it("лимит поля совпадает с валидацией", () => expect(MAX_TEXT).toBe(200));
});

describe("авто-рост", () => {
  it("высота = содержимое, но не больше потолка", () => {
    expect(clampHeight(40, 120)).toBe(40);
    expect(clampHeight(120, 120)).toBe(120);
    expect(clampHeight(300, 120)).toBe(120);
  });
});
