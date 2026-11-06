import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRevealer } from "../src/content/dom";
import { CARD_SELECTOR } from "../src/content/selectors";

const css = readFileSync("static/gate.css", "utf8");

describe("gate.css", () => {
  it("список селекторов совпадает с selectors.ts", () => {
    const m = /:is\(([^)]*)\)/.exec(css);
    expect(m).not.toBeNull();
    const fromCss = m![1]!.split(",").map((s) => s.trim()).sort();
    const fromTs = CARD_SELECTOR.split(",").map((s) => s.trim()).sort();
    expect(fromCss).toEqual(fromTs);
  });
  it("правила шлюза действуют только под атрибутом и скрывают без маркера", () => {
    expect(css).toMatch(/html\[data-slop-gate="allowlist"\]\s+:is\([^)]*\):not\(\[data-slop-show\]\)\s*\{\s*display:\s*none\s*!important/);
  });
  it("анимация: 320 мс, сдвиг 8px, reduced-motion отключает", () => {
    expect(css).toMatch(/320ms/);
    expect(css).toMatch(/translateY\(8px\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[^}]*\{[^}]*animation:\s*none/);
  });
});

describe("manifest", () => {
  const m = JSON.parse(readFileSync("static/manifest.json", "utf8"));
  it("content script на document_start с gate.css", () => {
    const cs = m.content_scripts[0];
    expect(cs.run_at).toBe("document_start");
    expect(cs.css).toEqual(["gate.css"]);
  });
});

describe("createRevealer (пачки с задержкой 120 мс)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("раскрывает пачкой с нарастающим индексом (макс. 7) и не чаще раза в 120 мс", () => {
    const calls: [string, number][] = [];
    const r = createRevealer<string>({ reveal: (e, i) => calls.push([e, i]), hide: () => {} });
    for (let i = 0; i < 10; i++) r.allow(`c${i}`);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(119);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(calls).toHaveLength(10);
    expect(calls.map((c) => c[1])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 7, 7]);
  });
  it("disallow до раскрытия отменяет показ", () => {
    const calls: string[] = [];
    const hidden: string[] = [];
    const r = createRevealer<string>({ reveal: (e) => calls.push(e), hide: (e) => hidden.push(e) });
    r.allow("a"); r.allow("b"); r.disallow("a");
    vi.advanceTimersByTime(200);
    expect(calls).toEqual(["b"]);
    expect(hidden).toEqual(["a"]);
  });
});
