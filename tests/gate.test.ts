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

describe("gate.css: индикатор ленты", () => {
  it.each(["searching", "done", "exhausted", "end", "unsafe", "error"])("у состояния %s есть значок", (st) => {
    expect(css).toContain(`#slop-feed-status[data-state="${st}"]`);
  });
  it("анимация только у «ищу» и отключается при prefers-reduced-motion", () => {
    const anim = [...css.matchAll(/animation:\s*([a-z-]+)/g)].map((m) => m[1]);
    expect(anim).toContain("slop-fs-spin");
    expect(anim).toContain("slop-fs-slide");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*slop-fs-icon[^@]*animation:\s*none/);
    // спиннер привязан к состоянию searching, а не к блоку целиком
    expect(css).toMatch(/\[data-state="searching"\] \.slop-fs-icon\s*\{[^}]*animation:\s*slop-fs-spin/);
  });
  it("тёмная тема YouTube (html[dark]), фокус кнопки, узкий экран, фиксированная минимальная высота", () => {
    expect(css).toMatch(/html\[dark\] #slop-feed-status/);
    expect(css).toMatch(/\.slop-fs-btn:focus-visible/);
    expect(css).toMatch(/@container \(max-width: 859px\)/);
    expect(css).toMatch(/#slop-feed-status\s*\{[^}]*container-type:\s*inline-size/);
    expect(css).toMatch(/\.slop-fs-card\s*\{[^}]*min-height:\s*84px/);
  });
  it("раскладка не прыгает: полоска не занимает места, на узком экране резерв под строку кнопок и текст", () => {
    expect(css).toMatch(/\.slop-fs-bar\s*\{[^}]*position:\s*absolute/);
    expect(css).not.toMatch(/\.slop-fs-bar\[hidden\]\s*\{[^}]*visibility/);
    const narrow = css.slice(css.indexOf("@container (max-width: 859px)"));
    expect(narrow).toMatch(/\.slop-fs-actions\s*\{[^}]*min-height:\s*44px/);
    expect(narrow).toMatch(/\.slop-fs-title\s*\{[^}]*min-height:\s*40px/);
    expect(narrow).toMatch(/\.slop-fs-detail\s*\{[^}]*min-height:\s*36px/);
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
