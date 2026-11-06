// Тонкая обёртка над chrome.i18n. Тексты лежат в static/_locales/{en,ru}/messages.json; язык выбирает Chrome.
// Результат t() и подстановки попадают в DOM только через textContent / setAttribute (см. design.md, «Модель угроз»).
type En = typeof import("../../static/_locales/en/messages.json");
type Ru = typeof import("../../static/_locales/ru/messages.json");
export type MsgKey = keyof En;

// Паритет ключей проверяется компилятором: расхождение en и ru даёт ошибку типа.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const KEYS_PARITY: Same<keyof En, keyof Ru> = true;

export interface I18nSource {
  getMessage(key: string, subs?: string | string[]): string;
  getUILanguage(): string;
}

let override: I18nSource | undefined;
/** Только для тестов: подменяет chrome.i18n. */
export function setI18nSource(s: I18nSource | undefined): void {
  override = s;
}
const src = (): I18nSource => override ?? chrome.i18n;

/** Сообщение по ключу. Нет сообщения в рантайме → сам ключ (видно сразу, не пустота). */
export function t(key: MsgKey, ...subs: Array<string | number>): string {
  const s = subs.length > 0 ? subs.map(String) : undefined;
  return src().getMessage(key, s) || key;
}

/** Локаль интерфейса браузера для Intl. */
export function locale(): string {
  try {
    return src().getUILanguage() || "en-US";
  } catch {
    return "en-US";
  }
}

const nf = (opts: Intl.NumberFormatOptions): Intl.NumberFormat => {
  try {
    return new Intl.NumberFormat(locale(), opts);
  } catch {
    return new Intl.NumberFormat("en-US", opts);
  }
};

export const formatInt = (v: number): string => nf({ maximumFractionDigits: 0 }).format(v);

const usd = (v: number, digits: number): string =>
  nf({ style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);

/** От 1 — два знака; меньше 1 — четыре; ненулевое, округляющееся до нуля, — «<0.0001»; ноль — без дроби. */
export function formatUsd(v: number): string {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return "—";
  if (v === 0) return usd(0, 0);
  if (v >= 1) return usd(v, 2);
  const s = v.toFixed(4);
  return s === "0.0000" ? t("usage_less_than", usd(0.0001, 4)) : usd(v, 4);
}

export interface I18nElement {
  getAttribute(n: string): string | null;
  setAttribute(n: string, v: string): void;
  textContent: string | null;
}
export interface I18nRoot {
  querySelectorAll(sel: string): Iterable<I18nElement>;
  setLang(l: string): void;
  setTitle(s: string): void;
}

/**
 * Проставляет тексты: [data-i18n="key"] → textContent; [data-i18n-attr="attr:key;attr:key"] → атрибуты;
 * заголовок страницы (titleKey) и <html lang>. Ключи берутся из разметки пакета; значения — только как текст.
 */
export function applyI18n(root: I18nRoot, titleKey?: MsgKey): void {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.getAttribute("data-i18n") as MsgKey);
  for (const el of root.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of (el.getAttribute("data-i18n-attr") ?? "").split(";")) {
      const i = pair.indexOf(":");
      if (i > 0) el.setAttribute(pair.slice(0, i).trim(), t(pair.slice(i + 1).trim() as MsgKey));
    }
  }
  if (titleKey) root.setTitle(t(titleKey));
  root.setLang(locale().split("-")[0]!.toLowerCase());
}

/** Адаптер настоящего document для applyI18n. */
export const domRoot = (doc: Document): I18nRoot => ({
  querySelectorAll: (sel) => doc.querySelectorAll<HTMLElement>(sel),
  setLang: (l) => doc.documentElement.setAttribute("lang", l),
  setTitle: (s) => {
    doc.title = s;
  },
});
