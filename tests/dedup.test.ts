import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedFilter } from "../src/content/filter";
import { pageScope } from "../src/content/selectors";
import type { DecideRequest, DecideResponse, PeekRequest, PeekResponse } from "../src/shared/decision";
import type { Mode, Settings } from "../src/shared/settings";

interface Card { id: string; page?: string; hidden: boolean; shown: boolean }
const S = (mode: Mode): Settings => ({ enabled: true, tags: [{ id: "t0", text: "IT", enabled: true }], mode, skipSubscriptions: true, filterSearch: false, compatUbol: false, feedTarget: 12 });
const yes: DecideResponse = { ok: true, hide: false, matchedTagIds: ["t0"], probabilities: {} };
const card = (id: string, page?: string): Card => ({ id, page, hidden: false, shown: false });

function setup(mode: Mode, cards: Card[], opts: { peek?: boolean; scope?: boolean; badScope?: boolean } = {}) {
  const sent: DecideRequest[] = [];
  const peeked: PeekRequest[] = [];
  const f = new FeedFilter<Card>(
    {
      findCards: () => cards,
      extract: (c) => ({ videoId: c.id, title: "t", channel: "c" }),
      hide: (c) => void (c.hidden = true),
      show: (c) => void (c.hidden = false),
      allow: (c) => void (c.shown = true),
      disallow: (c) => void (c.shown = false),
      setGate: () => undefined,
      send: async (r) => (sent.push(r), yes),
      ...(opts.scope ? { scope: (c: Card) => c.page } : {}),
      ...(opts.badScope ? { scope: () => { throw new Error("boom"); } } : {}),
      ...(opts.peek ? { peek: async (r: PeekRequest): Promise<PeekResponse> => (peeked.push(r), { ok: true, decisions: {} } as PeekResponse) } : {}),
    },
    S(mode),
  );
  return { f, sent, peeked };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const run = async (f: FeedFilter<Card>) => {
  f.schedule();
  await vi.advanceTimersByTimeAsync(600);
};

describe("дубли карточек", () => {
  it("allowlist: проявлена одна карточка, дубль под шлюзом, один вызов, счётчики без дубля", async () => {
    const cards = [card("v1"), card("v2"), card("v1"), card("v3"), card("v2")];
    const a = setup("allowlist", cards, { peek: true });
    await run(a.f);
    expect(cards.map((c) => c.shown)).toEqual([true, true, false, true, false]);
    expect(a.sent.map((r) => r.video.videoId).sort()).toEqual(["v1", "v2", "v3"]);
    expect(a.peeked.flatMap((r) => r.videos.map((v) => v.videoId)).sort()).toEqual(["v1", "v2", "v3"]);
    const s = a.f.snapshot();
    expect(s.visible).toBe(3);
    expect(s.cards).toBe(3);
    expect(s.pending).toBe(0);
  });

  it("blocklist: дубль скрыт, оригинал нет, запросов по дублю нет", async () => {
    const cards = [card("v1"), card("v1"), card("v2")];
    const a = setup("blocklist", cards);
    await run(a.f);
    expect(cards.map((c) => c.hidden)).toEqual([false, true, false]);
    expect(a.sent.map((r) => r.video.videoId).sort()).toEqual(["v1", "v2"]);
    expect(a.f.snapshot().cards).toBe(2);
  });

  it("смена videoId в узле: карточка перестаёт быть дублем и оценивается", async () => {
    const cards = [card("v1"), card("v1")];
    const a = setup("allowlist", cards);
    await run(a.f);
    expect(cards.map((c) => c.shown)).toEqual([true, false]);
    cards[1]!.id = "v9";
    await run(a.f);
    expect(cards.map((c) => c.shown)).toEqual([true, true]);
    expect(a.sent.map((r) => r.video.videoId).sort()).toEqual(["v1", "v9"]);
  });

  it("уход оригинала: дубль становится оригиналом (allowlist и blocklist)", async () => {
    for (const mode of ["allowlist", "blocklist"] as const) {
      const cards = [card("v1"), card("v1")];
      const a = setup(mode, cards);
      await run(a.f);
      cards.shift();
      await run(a.f);
      const c = cards[0]!;
      expect(mode === "allowlist" ? c.shown : !c.hidden).toBe(true);
      expect(a.sent).toHaveLength(1);
    }
  });

  it("смена id у оригинала: бывший дубль занимает место (blocklist: скрытие снято)", async () => {
    const cards = [card("v1"), card("v1")];
    const a = setup("blocklist", cards);
    await run(a.f);
    expect(cards[1]!.hidden).toBe(true);
    cards[0]!.id = "v7";
    await run(a.f);
    expect(cards.map((c) => c.hidden)).toEqual([false, false]);
  });

  it("карточки других страниц SPA не дубли", async () => {
    const cards = [card("v1", "old"), card("v1", "new"), card("v1", "new")];
    const a = setup("allowlist", cards, { scope: true });
    await run(a.f);
    expect(cards.map((c) => c.shown)).toEqual([true, true, false]);
  });

  it("исключение scope: карточки обычные (fail-open), нет падения", async () => {
    const cards = [card("v1"), card("v2")];
    const a = setup("allowlist", cards, { badScope: true });
    await run(a.f);
    expect(cards.map((c) => c.shown)).toEqual([true, true]);
  });

  it("неактивный фильтр не трогает дубли", async () => {
    const cards = [card("v1"), card("v1")];
    const a = setup("blocklist", cards);
    a.f.reconfigure({ ...S("blocklist"), enabled: false }, { onSubscriptions: false });
    await run(a.f);
    expect(cards.map((c) => c.hidden)).toEqual([false, false]);
    expect(a.sent).toHaveLength(0);
  });
});

describe("pageScope", () => {
  it("возвращает предка-страницу, при отсутствии/исключении null", () => {
    const page = {};
    expect(pageScope({ closest: (s: string) => (s === "ytd-page-manager > *" ? page : null) })).toBe(page);
    expect(pageScope({ closest: () => null })).toBeNull();
    expect(pageScope({})).toBeNull();
    expect(pageScope({ closest: () => { throw new Error("x"); } })).toBeNull();
  });
});
