import { afterEach, describe, expect, it } from "vitest";
import { applyI18n, formatInt, formatUsd, locale, setI18nSource, t, type I18nRoot } from "../src/shared/i18n";
import { getMessageFor, type Lang } from "./helpers/messages";

const use = (lang: Lang, ui = lang === "ru" ? "ru-RU" : "en-US"): void =>
  setI18nSource({ getMessage: getMessageFor(lang), getUILanguage: () => ui });
afterEach(() => setI18nSource(undefined));

describe("t", () => {
  it("ru и en возвращают свои тексты", () => {
    use("ru");
    expect(t("popup_add")).toBe("Добавить");
    use("en");
    expect(t("popup_add")).toBe("Add");
  });
  it("подстановки", () => {
    use("ru");
    expect(t("err_limit", 20)).toBe("Не больше 20 тегов.");
    expect(t("popup_counter", 7, 200)).toBe("7/200");
    use("en");
    expect(t("err_too_long", 200)).toBe("No more than 200 characters.");
  });
  it("нет сообщения в рантайме → возвращается ключ, не пустота", () => {
    setI18nSource({ getMessage: () => "", getUILanguage: () => "en" });
    expect(t("popup_add")).toBe("popup_add");
  });
});

describe("locale", () => {
  it.each([["ru-RU", "ru-RU"], ["en-US", "en-US"], ["de", "de"]])("getUILanguage %s", (ui, exp) => {
    use("en", ui);
    expect(locale()).toBe(exp);
  });
  it("пустое/сбой → en-US", () => {
    setI18nSource({ getMessage: () => "", getUILanguage: () => "" });
    expect(locale()).toBe("en-US");
    setI18nSource({ getMessage: () => "", getUILanguage: () => { throw new Error("x"); } });
    expect(locale()).toBe("en-US");
  });
});

describe("форматирование сумм по локали (точность сохранена)", () => {
  it("en", () => {
    use("en");
    expect([0, 0.0004, 0.0123, 0.5, 1, 74.5, 1234.567].map(formatUsd)).toEqual(["$0", "$0.0004", "$0.0123", "$0.5000", "$1.00", "$74.50", "$1,234.57"]);
    expect(formatUsd(0.00001)).toBe("<$0.0001");
    expect(formatUsd(0.99996)).toBe("$1.0000");
  });
  it("ru: десятичная запятая, те же значащие цифры", () => {
    use("ru");
    const norm = (s: string): string => s.replace(/\s/g, "");
    expect(norm(formatUsd(0.0123))).toMatch(/^0,0123(\$|US\$)$/);
    expect(norm(formatUsd(74.5))).toMatch(/^74,50(\$|US\$)$/);
    expect(norm(formatUsd(0.5))).toMatch(/^0,5000(\$|US\$)$/);
    expect(norm(formatUsd(0))).toMatch(/^0(\$|US\$)$/);
    expect(norm(formatUsd(0.00001))).toMatch(/^<0,0001(\$|US\$)$/);
  });
  it.each([[NaN], [-1], [Infinity]])("мусор %s → —", (v) => {
    use("en");
    expect(formatUsd(v)).toBe("—");
  });
  it("целые по локали", () => {
    use("en");
    expect(formatInt(12345)).toBe("12,345");
    use("ru");
    expect(formatInt(12345).replace(/\s/g, "")).toBe("12345");
  });
});

class El {
  attrs = new Map<string, string>();
  textContent = "";
  constructor(attrs: Record<string, string>) { for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v); }
  getAttribute(n: string): string | null { return this.attrs.get(n) ?? null; }
  setAttribute(n: string, v: string): void { this.attrs.set(n, v); }
}
function fakeRoot(els: El[], title = ""): I18nRoot & { title: string; lang: string } {
  const root = {
    title,
    lang: "",
    querySelectorAll(sel: string): El[] {
      return els.filter((e) => e.getAttribute(sel.slice(1, -1)) !== null);
    },
    setLang(l: string): void { root.lang = l; },
    setTitle(s: string): void { root.title = s; },
  };
  return root;
}

describe("applyI18n", () => {
  it("textContent, атрибуты, title страницы и lang — на выбранном языке; повторный вызов не мешает", () => {
    const a = new El({ "data-i18n": "popup_add" });
    const b = new El({ "data-i18n-attr": "placeholder:popup_placeholder_allowlist;aria-label:popup_new_tag" });
    const root = fakeRoot([a, b]);
    use("ru");
    applyI18n(root, "options_title");
    expect(a.textContent).toBe("Добавить");
    expect(b.getAttribute("placeholder")).toBe("Что показывать: продуктивность, IT, нейросети");
    expect(b.getAttribute("aria-label")).toBe("Новый тег");
    expect(root.title).toBe("slop-block — настройки");
    expect(root.lang).toBe("ru");
    use("en", "en-GB");
    applyI18n(root, "options_title");
    expect(a.textContent).toBe("Add");
    expect(root.lang).toBe("en");
  });
  it("мусорный ключ в разметке не ломает страницу и не интерпретируется как HTML", () => {
    const a = new El({ "data-i18n": "<img src=x onerror=alert(1)>" });
    use("en");
    applyI18n(fakeRoot([a]));
    expect(a.textContent).toBe("<img src=x onerror=alert(1)>"); // ключ как текст (textContent), не разметка
  });
  it("подстановка с разметкой остаётся текстом", () => {
    use("en");
    expect(t("options_key_saved_masked", "<img onerror=x>")).toBe("Key saved (<img onerror=x>).");
  });
});
