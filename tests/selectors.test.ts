import { describe, expect, it } from "vitest";
import { extractMeta, type ElLike } from "../src/content/selectors";

/** Фейковый элемент: карта «селектор → элемент»; querySelector находит по любому из перечисленных через запятую. */
function el(map: Record<string, ElLike | null> = {}, text: string | null = null, attrs: Record<string, string> = {}): ElLike {
  return {
    textContent: text,
    getAttribute: (n) => attrs[n] ?? null,
    querySelector: (sel) => {
      for (const part of sel.split(",").map((s) => s.trim())) if (map[part]) return map[part]!;
      return null;
    },
  };
}
const link = (href: string, extra: Record<string, string> = {}) => el({}, null, { href, ...extra });

describe("extractMeta", () => {
  it("главная/рекомендации: watch-ссылка, заголовок, канал", () => {
    const card = el({
      'a[href*="/watch?v="]': link("/watch?v=abc123XYZ_-&t=5"),
      "#video-title": el({}, "  Как похудеть за 3 дня  "),
      "ytd-channel-name a": el({}, "Канал 1"),
    });
    expect(extractMeta(card)).toEqual({ videoId: "abc123XYZ_-", title: "Как похудеть за 3 дня", channel: "Канал 1" });
  });
  it("поиск: описание", () => {
    const card = el({
      'a[href*="/watch?v="]': link("https://www.youtube.com/watch?v=vid00001"),
      "#video-title": el({}, "T"),
      "#channel-name a": el({}, "C"),
      "#description-text": el({}, " snippet "),
    });
    expect(extractMeta(card)).toEqual({ videoId: "vid00001", title: "T", channel: "C", description: "snippet" });
  });
  it("шортс: /shorts/ID, заголовок из aria-label ссылки, пустой канал", () => {
    const card = el({ 'a[href*="/shorts/"]': link("/shorts/SHORT_id01", { "aria-label": "Смешной шортс, 1 млн просмотров" }) });
    expect(extractMeta(card)).toEqual({ videoId: "SHORT_id01", title: "Смешной шортс, 1 млн просмотров", channel: "" });
  });
  it("нет ссылки / нет заголовка / плохой id → null", () => {
    expect(extractMeta(el({}))).toBeNull();
    expect(extractMeta(el({ 'a[href*="/watch?v="]': link("/watch?v=abcdefgh") }))).toBeNull();
    expect(extractMeta(el({ 'a[href*="/watch?v="]': link("/watch?v=a<b>"), "#video-title": el({}, "T") }))).toBeNull();
  });
  it("недоверенный заголовок остаётся строкой", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const m = extractMeta(el({ 'a[href*="/watch?v="]': link("/watch?v=abcdefgh"), "#video-title": el({}, evil) }));
    expect(m?.title).toBe(evil);
  });
  it("слишком длинные поля обрезаются", () => {
    const m = extractMeta(el({ 'a[href*="/watch?v="]': link("/watch?v=abcdefgh"), "#video-title": el({}, "x".repeat(1000)) }));
    expect(m!.title.length).toBeLessThanOrEqual(300);
  });
});
