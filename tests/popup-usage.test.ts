import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateUsd, usageView } from "../src/popup/usage";
import { formatUsd, setI18nSource } from "../src/shared/i18n";
import { getMessageFor, type Lang } from "./helpers/messages";
import type { UsageResponse } from "../src/shared/usage";

// подписи — по словарю нужного языка; числа — en-US (локали чисел проверяет i18n.test)
const useLang = (lang: Lang, ui = "en-US"): void => setI18nSource({ getMessage: getMessageFor(lang), getUILanguage: () => ui });
beforeEach(() => useLang("ru"));
afterEach(() => setI18nSource(undefined));

const local = { requestsToday: 3, requestsTotal: 10, tokensToday: 1500, tokensTotal: 12345 };
const ok = (r: Partial<{ usage: number; usageDaily: number; usageMonthly: number; limit: number | null; limitRemaining: number | null }> = {}): UsageResponse => ({
  ok: true, remote: { usage: 0.0123, usageDaily: 0.0004, usageMonthly: 0.01, limit: null, limitRemaining: null, ...r }, local,
});

describe("formatUsd", () => {
  it.each([
    [0, "$0"], [0.0004, "$0.0004"], [0.0123, "$0.0123"], [0.5, "$0.5000"], [1, "$1.00"], [74.5, "$74.50"], [1234.567, "$1,234.57"],
    [0.00001, "<$0.0001"], [0.00004, "<$0.0001"], [0.99996, "$1.0000"],
  ])("%s → %s", (v, s) => expect(formatUsd(v)).toBe(s));
  it.each([[NaN], [-1], [Infinity]])("мусор %s → —", (v) => expect(formatUsd(v)).toBe("—"));
});

describe("estimateUsd", () => {
  it("0,042 $ за 1 млн", () => {
    expect(estimateUsd(1_000_000)).toBeCloseTo(0.042, 10);
    expect(estimateUsd(0)).toBe(0);
  });
});

describe("usageView", () => {
  it("загрузка", () => expect(usageView(null)).toEqual({ state: "loading", text: "Загрузка…" }));
  it("успех без лимита: нет строки остатка", () => {
    const v = usageView(ok());
    expect(v.state).toBe("ok");
    expect(v.rows).toEqual([
      ["Сегодня", "$0.0004"], ["Всего", "$0.0123"], ["Запросов сегодня", "3"], ["Токенов сегодня / всего", "1,500 / 12,345"], ["≈ по цене Jev (всего)", "$0.0005"],
    ]);
  });
  it("лимит задан: строка остатка после «Всего»", () => {
    const v = usageView(ok({ limit: 100, limitRemaining: 74.5 }));
    expect(v.rows!.map((r) => r[0])).toEqual(["Сегодня", "Всего", "Остаток лимита", "Запросов сегодня", "Токенов сегодня / всего", "≈ по цене Jev (всего)"]);
    expect(v.rows![2]).toEqual(["Остаток лимита", "$74.50"]);
  });
  it("нет ключа", () => {
    expect(usageView({ ok: false, error: "no_key", local })).toMatchObject({ state: "no_key", text: "Ключ OpenRouter не задан" });
  });
  it.each([
    ["network", "Не удалось получить траты (сеть)"], ["rate_limited", "Слишком много запросов, повторите позже"], ["bad_response", "Неожиданный ответ OpenRouter"],
  ] as const)("ошибка %s: фиксированный текст + локальные счётчики", (e, t) => {
    const v = usageView({ ok: false, error: e, local });
    expect(v.state).toBe("error");
    expect(v.text).toBe(t);
    expect(v.rows).toEqual([["Запросов сегодня", "3"], ["Токенов сегодня / всего", "1,500 / 12,345"]]);
  });
  it("мусорный ответ → ошибка без деталей", () => {
    expect(usageView(undefined)).toMatchObject({ state: "error", text: "Не удалось получить траты (сеть)" });
    expect(usageView({ ok: false, error: "<b>x</b>", local } as any)).toMatchObject({ state: "error", text: "Неожиданный ответ OpenRouter" });
    expect(usageView({ ok: true, remote: { usage: "x" }, local: null } as any)).toMatchObject({ state: "error" });
  });
});

describe("usageView на английском", () => {
  it("подписи и сообщения en", () => {
    useLang("en");
    expect(usageView(null)).toEqual({ state: "loading", text: "Loading…" });
    expect(usageView(ok({ limit: 100, limitRemaining: 74.5 })).rows!.map((r) => r[0])).toEqual(["Today", "Total", "Limit remaining", "Requests today", "Tokens today / total", "≈ at Jev price (total)"]);
    expect(usageView({ ok: false, error: "no_key", local })).toMatchObject({ text: "OpenRouter key is not set" });
  });
  it("в ru-локали суммы с запятой, группы чисел по локали", () => {
    useLang("ru", "ru-RU");
    const v = usageView(ok());
    expect(v.rows![0]![1]!.replace(/[\s\u00a0\u202f]/g, "")).toMatch(/^0,0004(\$|US\$)$/);
    expect(v.rows![3]![1]!.replace(/[\s\u00a0\u202f]/g, "")).toBe("1500/12345");
  });
});

describe("popup и ключ", () => {
  // allowlist-reveal (main) показывает подсказку «нет ключа» по ФАКТУ наличия ключа: единственное чтение storage.local
  // в popup — readKeyPresent(), значение сразу сворачивается в boolean и никуда не передаётся. Блок трат ключа не касается:
  // он получает только числа от background.
  it("в src/popup ключ читается только в readKeyPresent (булево), блок трат ключа не касается", () => {
    const reads: string[] = [];
    for (const f of readdirSync("src/popup")) {
      const s = readFileSync(`src/popup/${f}`, "utf8");
      if (f === "usage.ts") expect(s).not.toMatch(/openrouterKey|storage\.|KEY_STORAGE/);
      for (const m of s.matchAll(/storage\.local/g)) reads.push(`${f}@${m.index}`);
      if (f === "index.ts") {
        const fn = s.slice(s.indexOf("async function readKeyPresent"), s.indexOf("function render("));
        expect(fn).toContain("typeof v === \"string\" && v.length > 0");
        expect(s.replace(fn, "").replace(/^import \{ KEY_STORAGE \} from "..\/background\/settings";\n/m, "")).not.toMatch(/KEY_STORAGE|openrouterKey|storage\.local/);
      }
    }
    expect(reads).toHaveLength(1);
  });
});
