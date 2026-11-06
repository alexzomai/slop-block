import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedFilter } from "../src/content/filter";
import type { DecideRequest, DecideResponse, VideoMeta } from "../src/shared/decision";
import type { Settings } from "../src/shared/settings";

interface Card { id: string; title: string; hidden: boolean }
const S = (tags: string[], enabled = true): Settings => ({ enabled, tags: tags.map((t, i) => ({ id: `t${i}`, text: t, enabled: true })), mode: "blocklist", skipSubscriptions: false, feedTarget: 12 });
const ok = (hide: boolean): DecideResponse => ({ ok: true, hide, matchedTagIds: hide ? ["t0"] : [], probabilities: {} });

function setup(settings: Settings, answer: (r: DecideRequest) => Promise<DecideResponse> | DecideResponse) {
  const cards: Card[] = [];
  const sent: DecideRequest[] = [];
  const f = new FeedFilter<Card>({
    findCards: () => cards,
    extract: (c): VideoMeta | null => (c.id ? { videoId: c.id, title: c.title, channel: "ch" } : null),
    hide: (c) => void (c.hidden = true),
    show: (c) => void (c.hidden = false),
    send: async (r) => { sent.push(r); return answer(r); },
  }, settings);
  return { f, cards, sent };
}
const flush = async () => { await vi.advanceTimersByTimeAsync(350); };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("FeedFilter", () => {
  it("шлёт контрактный запрос и скрывает при hide=true; hide=false не трогает", async () => {
    const { f, cards, sent } = setup(S(["кликбейт"]), (r) => ok(r.video.videoId === "bad"));
    cards.push({ id: "bad", title: "x", hidden: false }, { id: "good", title: "y", hidden: false });
    f.schedule(); await flush();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ type: "slop/decide", video: { videoId: "bad", title: "x", channel: "ch" }, tags: [{ id: "t0", text: "кликбейт" }] });
    expect(cards.map((c) => c.hidden)).toEqual([true, false]);
  });

  it("не шлёт одно видео повторно; решение применяется к другой карточке локально", async () => {
    const { f, cards, sent } = setup(S(["a"]), () => ok(true));
    cards.push({ id: "v1", title: "x", hidden: false });
    f.schedule(); await flush();
    cards.push({ id: "v1", title: "x", hidden: false });
    f.schedule(); await flush();
    expect(sent).toHaveLength(1);
    expect(cards.every((c) => c.hidden)).toBe(true);
  });

  it("переиспользованная карточка с другим видео показывается", async () => {
    const { f, cards } = setup(S(["a"]), (r) => ok(r.video.videoId === "v1"));
    const c: Card = { id: "v1", title: "x", hidden: false };
    cards.push(c);
    f.schedule(); await flush();
    expect(c.hidden).toBe(true);
    c.id = "v2";
    f.schedule(); await flush();
    expect(c.hidden).toBe(false);
  });

  it("fail-open: ok:false и исключение не скрывают", async () => {
    let n = 0;
    const { f, cards } = setup(S(["a"]), () => { if (n++ === 0) return { ok: false, error: "no_key" }; throw new Error("no receiver"); });
    cards.push({ id: "v1", title: "x", hidden: false }, { id: "v2", title: "y", hidden: false });
    f.schedule(); await flush();
    expect(cards.every((c) => !c.hidden)).toBe(true);
  });

  it("дебаунс: много schedule → один проход", async () => {
    const { f, cards, sent } = setup(S(["a"]), () => ok(false));
    cards.push({ id: "v1", title: "x", hidden: false });
    for (let i = 0; i < 10; i++) f.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(0);
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("параллельность ≤ 3", async () => {
    let cur = 0, max = 0;
    const { f, cards } = setup(S(["a"]), async () => { cur++; max = Math.max(max, cur); await new Promise((r) => setTimeout(r, 50)); cur--; return ok(false); });
    for (let i = 0; i < 8; i++) cards.push({ id: `video${i}`, title: "x", hidden: false });
    f.schedule(); await vi.advanceTimersByTimeAsync(2000);
    expect(max).toBe(3);
  });

  it("фильтр выключен или нет тегов → запросов нет", async () => {
    const a = setup(S(["a"], false), () => ok(true));
    a.cards.push({ id: "v1", title: "x", hidden: false });
    a.f.schedule(); await flush();
    const b = setup(S([]), () => ok(true));
    b.cards.push({ id: "v1", title: "x", hidden: false });
    b.f.schedule(); await flush();
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(0);
  });

  it("выключение фильтра возвращает карточки; смена тегов оценивает заново", async () => {
    const { f, cards, sent } = setup(S(["a"]), () => ok(true));
    cards.push({ id: "v1", title: "x", hidden: false });
    f.schedule(); await flush();
    expect(cards[0]!.hidden).toBe(true);
    f.updateSettings(S(["a"], false)); await flush();
    expect(cards[0]!.hidden).toBe(false);
    f.updateSettings(S(["a", "b"])); await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.tags).toHaveLength(2);
    expect(cards[0]!.hidden).toBe(true);
  });

  it("ответ от устаревших настроек игнорируется", async () => {
    let release!: (r: DecideResponse) => void;
    const { f, cards } = setup(S(["a"]), () => new Promise<DecideResponse>((r) => (release = r)));
    cards.push({ id: "v1", title: "x", hidden: false });
    f.schedule(); await flush();
    f.updateSettings(S(["a"], false));
    release(ok(true)); await flush();
    expect(cards[0]!.hidden).toBe(false);
  });
});
