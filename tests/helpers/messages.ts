import { readFileSync } from "node:fs";

export type Lang = "en" | "ru";
export interface Entry { message: string; placeholders?: Record<string, { content: string }> }
export type Catalog = Record<string, Entry>;

export const catalog = (lang: Lang): Catalog =>
  JSON.parse(readFileSync(`static/_locales/${lang}/messages.json`, "utf8")) as Catalog;

/** Эмуляция chrome.i18n.getMessage по настоящим messages.json (плейсхолдеры $name$ → $1…). */
export function getMessageFor(lang: Lang): (key: string, subs?: string | string[]) => string {
  const c = catalog(lang);
  return (key, subs) => {
    const e = c[key];
    if (!e) return "";
    const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
    return e.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (_m, name: string) => {
      const ph = Object.entries(e.placeholders ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase());
      const content = ph ? ph[1].content : "";
      return content.replace(/\$(\d)/g, (_x, d: string) => list[Number(d) - 1] ?? "");
    });
  };
}

/** Плейсхолдеры сообщения, отсортированные (для проверки паритета). */
export const placeholdersOf = (e: Entry): string[] => Object.keys(e.placeholders ?? {}).map((k) => k.toLowerCase()).sort();
