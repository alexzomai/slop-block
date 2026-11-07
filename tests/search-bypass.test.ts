import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedFilter } from "../src/content/filter";
import type { DecideRequest, DecideResponse } from "../src/shared/decision";
import { isSearchPath } from "../src/shared/paths";
import { DEFAULT_SETTINGS, effectiveState, normalize, setFilterSearch, type Mode, type Settings } from "../src/shared/settings";
import { fromItems, loadSettings, saveSettings, toItems } from "../src/shared/storage";
import { PopupController } from "../src/popup/controller";

const S = (o: Partial<Settings> = {}): Settings => ({ enabled: true, tags: [{ id: "t0", text: "IT", enabled: true }], mode: "allowlist", skipSubscriptions: true, filterSearch: false, feedTarget: 12, ...o });

describe("isSearchPath", () => {
  it.each([
    ["/results", true], ["/results/", true], ["/", false], ["/hashtag/cats", false], ["/results/x", false], ["/result", false],
    ["/watch", false], ["/feed/subscriptions", false], ["/@channel/search", false], ["", false],
  ])("%s → %s", (p, want) => expect(isSearchPath(p)).toBe(want));
  it("нестроки → false", () => {
    for (const v of [undefined, null, 5, {}, ["/results"]]) expect(isSearchPath(v)).toBe(false);
  });
});

describe("filterSearch: нормализация и миграция", () => {
  it("по умолчанию false; старые настройки без поля → false", () => {
    expect(DEFAULT_SETTINGS.filterSearch).toBe(false);
    expect(normalize(undefined).filterSearch).toBe(false);
    expect(normalize({ enabled: true, mode: "blocklist", skipSubscriptions: false, tags: [] }).filterSearch).toBe(false);
  });
  it.each(["yes", 1, null, "true", {}])("мусор (%j) → false", (v) => expect(normalize({ filterSearch: v }).filterSearch).toBe(false));
  it("true сохраняется", () => expect(normalize({ filterSearch: true }).filterSearch).toBe(true));
  it("setFilterSearch", () => expect(setFilterSearch(S(), true).filterSearch).toBe(true));
  it("round-trip через items", () => {
    const s = S({ filterSearch: true });
    expect(fromItems(toItems(s))).toEqual(s);
  });
  it("round-trip через storage; миграция не пишет", async () => {
    const data: Record<string, unknown> = { "slop.settings": { enabled: true, order: [], mode: "allowlist", skipSubscriptions: true } };
    const writes: unknown[] = [];
    const area = {
      get: async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in data).map((x) => [x, data[x]])),
      set: async (o: Record<string, unknown>) => void (writes.push(o), Object.assign(data, o)),
      remove: async () => {},
    };
    expect((await loadSettings(area as never)).filterSearch).toBe(false);
    expect(writes).toHaveLength(0);
    await saveSettings(area as never, S({ tags: [], filterSearch: true }));
    expect((await loadSettings(area as never)).filterSearch).toBe(true);
  });
});

describe("effectiveState: поиск", () => {
  const ctx = (o: object) => ({ onSubscriptions: false, keyMissing: false, ...o });
  it.each(["allowlist", "blocklist"] as Mode[])("%s: поиск + filterSearch=false → неактивен", (mode) => {
    expect(effectiveState(S({ mode }), ctx({ onSearch: true })).active).toBe(false);
  });
  it("поиск + filterSearch=true → активен", () => expect(effectiveState(S({ filterSearch: true }), ctx({ onSearch: true })).active).toBe(true));
  it("не поиск → настройка не влияет", () => {
    expect(effectiveState(S(), ctx({ onSearch: false })).active).toBe(true);
    expect(effectiveState(S(), ctx({})).active).toBe(true);
  });
  it("не зависит от skipSubscriptions", () =>
    expect(effectiveState(S({ skipSubscriptions: false }), ctx({ onSearch: true })).active).toBe(false));
  it("подписки не затронуты поиском", () => {
    expect(effectiveState(S({ filterSearch: true }), ctx({ onSubscriptions: true })).active).toBe(false);
    expect(effectiveState(S({ skipSubscriptions: false }), ctx({ onSubscriptions: true })).active).toBe(true);
  });
});

describe("FeedFilter на поиске", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const make = (settings: Settings) => {
    const card = { shown: false, hidden: false };
    const sent: DecideRequest[] = [];
    const env = { gate: false };
    const f = new FeedFilter<typeof card>({
      findCards: () => [card],
      extract: () => ({ videoId: "v1", title: "t", channel: "c" }),
      hide: (c) => void (c.hidden = true),
      show: (c) => void (c.hidden = false),
      allow: (c) => void (c.shown = true),
      disallow: (c) => void (c.shown = false),
      setGate: (on) => void (env.gate = on),
      send: async (r): Promise<DecideResponse> => (sent.push(r), { ok: true, hide: false, matchedTagIds: [], probabilities: {} }),
    }, settings);
    return { f, card, sent, env, visible: () => (env.gate ? card.shown : !card.hidden) };
  };
  it("filterSearch=false: 0 запросов, шлюза нет, карточка видна", async () => {
    const a = make(S());
    a.f.reconfigure(S(), { onSubscriptions: false, onSearch: true });
    a.f.schedule();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(a.sent).toHaveLength(0);
    expect(a.env.gate).toBe(false);
    expect(a.visible()).toBe(true);
    expect(a.f.snapshot().active).toBe(false);
  });
  it("filterSearch=true: фильтр работает; возврат с поиска включает фильтр", async () => {
    const a = make(S());
    a.f.reconfigure(S({ filterSearch: true }), { onSubscriptions: false, onSearch: true });
    a.f.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(a.sent).toHaveLength(1);
    expect(a.visible()).toBe(false);
    a.f.reconfigure(S({ filterSearch: false }), { onSubscriptions: false, onSearch: true });
    expect(a.visible()).toBe(true);
    a.f.reconfigure(S({ filterSearch: false }), { onSubscriptions: false, onSearch: false });
    expect(a.env.gate).toBe(true);
  });
});

describe("PopupController: filterSearch", () => {
  it("сохраняется и рендерится", async () => {
    const saved: Settings[] = [];
    const c = new PopupController({ save: async (s) => void saved.push(s), render: () => {} }, S());
    expect(await c.setFilterSearch(true)).toBe(true);
    expect(c.state.filterSearch).toBe(true);
    expect(saved).toHaveLength(1);
  });
});

describe("FeedFilter: актуализация контекста по location (окно SPA-перехода)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const ids = ["a", "b", "c", "d", "e", "f"];
  const make = (settings: Settings) => {
    const live = { onSubscriptions: false, onSearch: false };
    const cards = ids.map((id) => ({ id, shown: false, hidden: false }));
    const sent: string[] = [];
    const resolvers: Array<() => void> = [];
    const env = { gate: false };
    const f = new FeedFilter<(typeof cards)[number]>({
      findCards: () => cards,
      extract: (c) => ({ videoId: c.id, title: "t", channel: "c" }),
      hide: (c) => void (c.hidden = true),
      show: (c) => void (c.hidden = false),
      allow: (c) => void (c.shown = true),
      disallow: (c) => void (c.shown = false),
      setGate: (on) => void (env.gate = on),
      context: () => ({ ...live }),
      send: (r): Promise<DecideResponse> => new Promise((res) => {
        sent.push(r.video.videoId);
        resolvers.push(() => res({ ok: true, hide: false, matchedTagIds: ["t0"], probabilities: {} }));
      }),
    }, settings, { ...live });
    return { f, cards, sent, resolvers, env, live, visible: (c: (typeof cards)[number]) => (env.gate ? c.shown : !c.hidden) };
  };
  it("страница стала поиском без событий: ответы не применяются, новых отправок нет, всё видно", async () => {
    const a = make(S());
    a.f.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(a.sent).toHaveLength(3);
    a.live.onSearch = true; // pushState без finish / childList
    a.resolvers.splice(0).forEach((r) => r());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(a.sent).toHaveLength(3);
    expect(a.env.gate).toBe(false);
    expect(a.cards.every(a.visible)).toBe(true);
    expect(a.f.snapshot().active).toBe(false);
  });
  it("ранняя синхронизация снимает шлюз сразу", async () => {
    const a = make(S());
    a.f.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(a.env.gate).toBe(true);
    a.live.onSearch = true;
    a.f.syncContext();
    expect(a.env.gate).toBe(false);
    expect(a.cards.every(a.visible)).toBe(true);
  });
  it("обратно results → home без события: фильтр включается и карточки оцениваются", async () => {
    const a = make(S());
    a.live.onSearch = true;
    a.f.reconfigure(S(), { ...a.live });
    a.f.schedule();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(a.sent).toHaveLength(0);
    a.live.onSearch = false;
    a.f.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(a.sent).toHaveLength(3);
    expect(a.env.gate).toBe(true);
  });
});
