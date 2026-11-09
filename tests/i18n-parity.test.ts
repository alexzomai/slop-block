import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalog, placeholdersOf } from "./helpers/messages";

const en = catalog("en");
const ru = catalog("ru");
const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8")) as Record<string, any>;

describe("messages.json: паритет en/ru", () => {
  it("множества ключей равны", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });
  it("плейсхолдеры каждого сообщения совпадают", () => {
    for (const k of Object.keys(en)) expect(placeholdersOf(ru[k]!), k).toEqual(placeholdersOf(en[k]!));
  });
  it("значения не пусты, ключи — допустимые идентификаторы", () => {
    for (const [lang, c] of [["en", en], ["ru", ru]] as const) {
      for (const [k, v] of Object.entries(c)) {
        expect(k, `${lang}:${k}`).toMatch(/^[A-Za-z0-9_]+$/);
        expect(v.message.trim().length, `${lang}:${k}`).toBeGreaterThan(0);
      }
    }
  });
  it("в сообщениях нет разметки", () => {
    for (const [lang, c] of [["en", en], ["ru", ru]] as const) {
      for (const [k, v] of Object.entries(c)) expect(v.message, `${lang}:${k}`).not.toMatch(/[<>](?!\$)|<[a-z/!]/i);
    }
  });
  it("заложены ключи autofill для ветки feed-autofill", () => {
    for (const c of [en, ru]) {
      expect(c.autofill_searching).toBeDefined();
      expect(c.autofill_exhausted).toBeDefined();
    }
    expect(ru.autofill_searching!.message).toBe("Ищу ещё подходящие видео…");
    expect(ru.autofill_exhausted!.message).toBe("Больше подходящих не нашлось — прокрутите или измените теги");
    expect(ru.autofill_unsafe!.message).toBe("Прокрутите вниз, чтобы загрузить ещё");
    expect(en.popup_feed_target).toBeDefined();
  });
  it("русский словарь не копия английского (кроме брендовых значений)", () => {
    const same = Object.keys(en).filter((k) => en[k]!.message === ru[k]!.message);
    expect(same.sort()).toEqual(["ext_name", "options_key_placeholder", "options_provider_openrouter", "options_provider_typesafe", "popup_counter", "usage_pair", "usage_less_than"].sort());
  });
});

describe("manifest и _locales", () => {
  it("default_locale = en, каталоги есть", () => {
    expect(manifest.default_locale).toBe("en");
    expect(existsSync("static/_locales/en/messages.json")).toBe(true);
    expect(existsSync("static/_locales/ru/messages.json")).toBe(true);
  });
  it("name, description, default_title — через __MSG_*__, и ключи разрешаются в обеих локалях", () => {
    const refs = [manifest.name, manifest.description, manifest.action?.default_title];
    for (const r of refs) {
      expect(r).toMatch(/^__MSG_[A-Za-z0-9_]+__$/);
      const key = String(r).slice(6, -2);
      expect(en[key], key).toBeDefined();
      expect(ru[key], key).toBeDefined();
    }
  });
});
