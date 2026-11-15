import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedFilter } from "../src/content/filter";
import { isAdHref, isAdSlot, type AdLike } from "../src/content/selectors";
import type { DecideRequest, DecideResponse, PeekRequest, PeekResponse } from "../src/shared/decision";
import type { Mode, Settings } from "../src/shared/settings";

interface Card { id: string; ad: boolean; hidden: boolean; shown: boolean }
const S = (mode: Mode): Settings => ({ enabled: true, tags: [{ id: "t0", text: "IT", enabled: true }], mode, skipSubscriptions: true, filterSearch: false, compatUbol: false, feedTarget: 12 });
const yes: DecideResponse = { ok: true, hide: false, matchedTagIds: ["t0"], probabilities: {} };

function setup(mode: Mode, cards: Card[], opts: { peek?: boolean; throwing?: boolean } = {}) {
  const sent: DecideRequest[] = [];
  const peeked: PeekRequest[] = [];
  const f = new FeedFilter<Card>(
    {
      findCards: () => cards,
      extract: (c) => ({ videoId: c.id, title: "t", channel: "c" }),
      isAd: (c) => {
        if (opts.throwing) throw new Error("boom");
        return c.ad;
      },
      hide: (c) => void (c.hidden = true),
      show: (c) => void (c.hidden = false),
      allow: (c) => void (c.shown = true),
      disallow: (c) => void (c.shown = false),
      setGate: () => undefined,
      send: async (r) => (sent.push(r), yes),
      ...(opts.peek ? { peek: async (r: PeekRequest): Promise<PeekResponse> => (peeked.push(r), { ok: true, decisions: {} } as PeekResponse) } : {}),
    },
    S(mode),
  );
  return { f, sent, peeked };
}
const card = (id: string, ad = false): Card => ({ id, ad, hidden: false, shown: false });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("рекламные слоты в фильтре", () => {
  it("allowlist: реклама не засчитывается, не отправляется (ни decide, ни peek), остаётся скрытой", async () => {
    const cards = [card("v1"), card("ad1", true), card("ad2", true), card("v2")];
    const a = setup("allowlist", cards, { peek: true });
    a.f.schedule();
    await vi.advanceTimersByTimeAsync(600);
    expect(a.sent.map((r) => r.video.videoId).sort()).toEqual(["v1", "v2"]);
    expect(a.peeked.flatMap((r) => r.videos.map((v) => v.videoId)).sort()).toEqual(["v1", "v2"]);
    expect(cards.filter((c) => c.shown).map((c) => c.id)).toEqual(["v1", "v2"]);
    const s = a.f.snapshot();
    expect(s.visible).toBe(2);
    expect(s.cards).toBe(2);
    expect(s.pending).toBe(0);
  });
  it("allowlist: уже проявленная карточка, ставшая рекламой, возвращается под шлюз", async () => {
    const c = card("v1");
    const a = setup("allowlist", [c]);
    a.f.schedule();
    await vi.advanceTimersByTimeAsync(600);
    expect(c.shown).toBe(true);
    c.ad = true;
    a.f.scan();
    expect(c.shown).toBe(false);
    expect(a.f.snapshot().visible).toBe(0);
  });
  it("blocklist: реклама не трогается и не оценивается, в «проверено» не входит", async () => {
    const cards = [card("v1"), card("ad1", true)];
    const a = setup("blocklist", cards);
    a.f.schedule();
    await vi.advanceTimersByTimeAsync(600);
    expect(a.sent.map((r) => r.video.videoId)).toEqual(["v1"]);
    expect(cards[1]!.hidden).toBe(false);
    expect(cards[1]!.shown).toBe(false);
    expect(a.f.snapshot().cards).toBe(1);
  });
  it("compatUbol: реклама отсекается до rendered() — повторной проверки нет, в счёт не входит", async () => {
    const cards = [card("v1"), card("ad1", true), card("ad2", true)];
    const checked: string[] = [];
    const f = new FeedFilter<Card>(
      {
        findCards: () => cards,
        extract: (c) => ({ videoId: c.id, title: "t", channel: "c" }),
        isAd: (c) => c.ad,
        rendered: (c) => (checked.push(c.id), true),
        hide: (c) => void (c.hidden = true),
        show: (c) => void (c.hidden = false),
        allow: (c) => void (c.shown = true),
        disallow: (c) => void (c.shown = false),
        setGate: () => undefined,
        send: async () => yes,
      },
      { ...S("allowlist"), compatUbol: true },
    );
    f.schedule();
    await vi.advanceTimersByTimeAsync(600);
    expect(checked).not.toContain("ad1");
    expect(checked).not.toContain("ad2");
    expect(f.snapshot()).toMatchObject({ visible: 1, cards: 1 });
  });
  it("fail-open: исключение в isAd — обычная карточка", async () => {
    const cards = [card("v1", true)];
    const a = setup("allowlist", cards, { throwing: true });
    a.f.schedule();
    await vi.advanceTimersByTimeAsync(600);
    expect(a.sent).toHaveLength(1);
    expect(cards[0]!.shown).toBe(true);
  });
});

/** Фейк элемента с набором «сработавших» селекторов по подстроке. */
function el(o: { matches?: string[]; has?: string[]; badges?: string[]; links?: string[] } = {}): AdLike {
  const node = (t: string | null, href: string | null = null): AdLike => ({ textContent: t, getAttribute: (n) => (n === "href" ? href : null), querySelector: () => null });
  return {
    textContent: null,
    getAttribute: () => null,
    matches: (sel) => (o.matches ?? []).some((m) => sel.includes(m)),
    querySelector: (sel) => ((o.has ?? []).some((m) => sel.includes(m)) ? node("x") : null),
    querySelectorAll: (sel) => (sel === "a[href]" ? (o.links ?? []).map((h) => node(null, h)) : (o.badges ?? []).map((b) => node(b))),
  };
}

describe("isAdSlot", () => {
  it("рекламные рендереры внутри карточки", () => {
    for (const tag of ["ytd-ad-slot-renderer", "ytd-in-feed-ad-layout-renderer", "ytd-display-ad-renderer", "ad-badge-view-model"]) expect(isAdSlot(el({ has: [tag] }))).toBe(true);
  });
  it("сама карточка — рекламный рендерер", () => {
    expect(isAdSlot(el({ matches: ["ytd-promoted-video-renderer"] }))).toBe(true);
  });
  it("рекламная ссылка (редирект): по hostname и пути", () => {
    for (const h of ["https://www.googleadservices.com/pagead/aclk?sa=L", "https://googleads.g.doubleclick.net/aclk?x=1", "https://ad.doubleclick.net/ddm/clk/1", "https://www.youtube.com/pagead/adview?ai=1", "/pagead/aclk?x", "https://tpc.googlesyndication.com/x"])
      expect(isAdSlot(el({ links: ["/watch?v=real0000001", h] }))).toBe(true);
  });
  it("обычные ссылки YouTube с рекламным доменом в handle/path/query — не реклама", () => {
    for (const h of [
      "https://www.youtube.com/@doubleclick.net",
      "https://www.youtube.com/@googleadservices.com/videos",
      "/@doubleclick.net",
      "/channel/doubleclick.net",
      "/watch?v=abc123XYZ_-&u=googleadservices.com",
      "https://www.youtube.com/results?search_query=doubleclick.net",
      "/redirect?q=https%3A%2F%2Fdoubleclick.net%2F",
      "https://notdoubleclick.net/x",
      "https://doubleclick.net.evil.example/x",
      "https://www.youtube.com/aclk-fan",
      "/watch?v=aclk&list=/pagead/",
    ])
      expect(isAdSlot(el({ links: [h] })), h).toBe(false);
    expect(isAdHref(null)).toBe(false);
    expect(isAdHref("http://[bad")).toBe(false);
  });
  it("бейдж «Sponsored» на разных языках — без опоры на один язык", () => {
    for (const t of ["Sponsored", "Реклама", "Anzeige", "広告", " Publicidad "]) expect(isAdSlot(el({ badges: [t] }))).toBe(true);
  });
  it("обычная карточка и обычные бейджи — не реклама; текст «Sponsored» не в бейдже не считается", () => {
    expect(isAdSlot(el())).toBe(false);
    expect(isAdSlot(el({ badges: ["LIVE", "Новое", "4K", "Sponsored by Foo"] }))).toBe(false);
  });
  it("исключение — не реклама", () => {
    const bad: AdLike = { textContent: null, getAttribute: () => null, querySelector: () => { throw new Error("x"); } };
    expect(isAdSlot(bad)).toBe(false);
  });
});
