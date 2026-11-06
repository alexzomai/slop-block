import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedFilter } from "../src/content/filter";
import type { DecideResponse } from "../src/shared/decision";
import type { Settings } from "../src/shared/settings";

interface Card { id: string; shown: boolean }
const S = (o: Partial<Settings> = {}): Settings => ({ enabled: true, tags: [{ id: "t0", text: "IT", enabled: true }], mode: "allowlist", skipSubscriptions: true, feedTarget: 12, ...o });
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
    expect(f.snapshot()).toEqual({ active: true, mode: "allowlist", visible: 1, cards: 3, pending: 1 });
    release!();
    await vi.advanceTimersByTimeAsync(10);
    expect(f.snapshot()).toMatchObject({ visible: 1, cards: 3, pending: 0 });
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
