import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedFilter } from "../src/content/filter";
import type { DecideResponse } from "../src/shared/decision";
import type { Settings } from "../src/shared/settings";

interface Card { id: string; shown: boolean }
const S = (o: Partial<Settings> = {}): Settings => ({ enabled: true, tags: [{ id: "t0", text: "IT", enabled: true }], mode: "allowlist", skipSubscriptions: true, filterSearch: false, compatUbol: false, feedTarget: 12, ...o });
const yes: DecideResponse = { ok: true, hide: true, matchedTagIds: ["t0"], probabilities: {} };
const no: DecideResponse = { ok: true, hide: false, matchedTagIds: [], probabilities: {} };

function setup(settings: Settings, answer: (id: string) => Promise<DecideResponse> | DecideResponse | "threw", ids: string[]) {
  const cards: Card[] = ids.map((id) => ({ id, shown: false }));
  let settled = 0;
  const f = new FeedFilter<Card>({
    findCards: () => cards,
    extract: (c) => ({ videoId: c.id, title: "t", channel: "c" }),
    hide: () => {}, show: () => {},
    allow: (c) => void (c.shown = true),
    disallow: (c) => void (c.shown = false),
    send: async (r) => {
      const a = await answer(r.video.videoId);
      if (a === "threw") throw new Error("x");
      return a;
    },
    onSettled: () => void settled++,
  }, settings);
  return { f, cards, settled: () => settled };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("FeedFilter.snapshot / onSettled", () => {
  it("allowlist: visible = разрешённые, cards = найденные, pending = очередь+полёт", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { f } = setup(S(), async (id) => { if (id === "slow") await gate; return id === "a" ? yes : no; }, ["a", "b", "slow"]);
    f.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(f.snapshot()).toEqual({ active: true, mode: "allowlist", visible: 1, cards: 3, pending: 1, failure: null });
    release!();
    await vi.advanceTimersByTimeAsync(10);
    expect(f.snapshot()).toMatchObject({ visible: 1, cards: 3, pending: 0 });
  });
  it("перерисовка клонами тех же видео не увеличивает visible (visible ≤ cards, по уникальным videoId)", async () => {
    const { f, cards } = setup(S(), () => yes, ["a", "b"]);
    f.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(f.snapshot().visible).toBe(2);
    for (let i = 0; i < 5; i++) {
      // страница заменяет узлы клонами с теми же videoId; на миг старые и клоны вместе
      const old = cards.splice(0, cards.length);
      cards.push(...old.map((c) => ({ id: c.id, shown: false })), ...old);
      f.scan(false);
      expect(f.snapshot().visible).toBe(2);
      cards.splice(0, old.length);
      f.scan(false);
      await vi.advanceTimersByTimeAsync(400);
      const s = f.snapshot();
      expect(s.visible).toBe(2);
      expect(s.visible).toBeLessThanOrEqual(s.cards);
    }
  });
  it("onSettled вызывается после прохода", async () => {
    const { f, settled } = setup(S(), () => yes, ["a"]);
    f.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(settled()).toBeGreaterThan(0);
  });
  it("ожидающие повтор после сбоя не входят в pending", async () => {
    const { f } = setup(S(), () => "threw", ["a"]);
    f.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(f.snapshot().pending).toBe(0);
  });
  it("неактивный фильтр: active=false", () => {
    const { f } = setup(S({ enabled: false }), () => yes, ["a"]);
    expect(f.snapshot().active).toBe(false);
  });
  it("blocklist: mode=blocklist (автодогрузка не eligible)", () => {
    const { f } = setup(S({ mode: "blocklist" }), () => yes, ["a"]);
    expect(f.snapshot().mode).toBe("blocklist");
  });
  it("после reconfigure (scan без постановки в очередь) нерешённые карточки уже считаются pending", () => {
    const { f } = setup(S(), () => yes, ["a", "b"]);
    f.reconfigure(S(), { onSubscriptions: false });
    expect(f.snapshot().pending).toBe(2);
  });
  it("карточки с решением, терминальные и ждущие повтора не блокируют", async () => {
    const { f } = setup(S(), (id) => (id === "a" ? yes : id === "b" ? { ok: false, error: "bad_response" } : "threw"), ["a", "b", "c"]);
    f.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(f.snapshot().pending).toBe(0);
  });
});

describe("FeedFilter.snapshot().failure (индикатор «фильтр не работает»)", () => {
  const noKey: DecideResponse = { ok: false, error: "no_key" };
  it("нет ключа / ключ отклонён (для контента — no_key) → failure=no_key, фильтр неактивен (fail-open)", async () => {
    const { f } = setup(S(), () => noKey, ["a", "b"]);
    f.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(f.snapshot()).toMatchObject({ active: false, failure: "no_key" });
  });
  it.each([
    ["rate_limited", { ok: false, error: "rate_limited" } as DecideResponse],
    ["network", { ok: false, error: "network" } as DecideResponse],
    ["bad_response", { ok: false, error: "bad_response" } as DecideResponse],
    ["no_credits", { ok: false, error: "no_credits" } as DecideResponse],
    ["access_denied", { ok: false, error: "access_denied" } as DecideResponse],
  ] as const)("сбой %s без единого решения → failure; активность не меняется", async (reason, answer) => {
    const { f } = setup(S(), () => answer, ["a", "b"]);
    f.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(f.snapshot()).toMatchObject({ active: true, failure: reason });
  });
  it("исключение/просрочка отправки → network", async () => {
    const { f } = setup(S(), () => "threw", ["a"]);
    f.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(f.snapshot().failure).toBe("network");
  });
  it("любое успешное решение снимает failure провайдера", async () => {
    const { f } = setup(S(), (id) => (id === "a" ? ({ ok: false, error: "network" } as DecideResponse) : yes), ["a", "b"]);
    f.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(f.snapshot().failure).toBeNull();
  });
  it("смена настроек сбрасывает no_key", async () => {
    const { f } = setup(S(), () => noKey, ["a"]);
    f.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(f.snapshot().failure).toBe("no_key");
    f.reconfigure(S({ feedTarget: 20 }), { onSubscriptions: false, onSearch: false });
    expect(f.snapshot().failure).toBeNull();
  });
  it("сбой провайдера: между повторами карточки скрыты (задокументированное поведение), поэтому индикатор не обещает «без фильтрации»", async () => {
    const { f, cards } = setup(S(), () => ({ ok: false, error: "network" }) as DecideResponse, ["a"]);
    f.schedule();
    await vi.advanceTimersByTimeAsync(400);
    expect(f.snapshot().failure).toBe("network");
    expect(cards[0]!.shown).toBe(false);
  });
});
