import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedFilter } from "../src/content/filter";
import type { DecideResponse } from "../src/shared/decision";

// Контракт: при неизменных тегах одно videoId отправляется не более 1+N раз, N=2.
// no_key / bad_response терминальны; network / rate_limited / исключение sendMessage — повторы через 30 с и 120 с
// после предыдущей неудачи (дебаунс на повторы не накладывается).
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

type Outcome = DecideResponse | "throw" | "undefined";
const TAGS = { enabled: true, tags: [{ id: "a", text: "tag", enabled: true }], mode: "blocklist" as const, skipSubscriptions: false, filterSearch: false, feedTarget: 12 };

async function run(outcome: Outcome, horizonMs = 400_000) {
  const stamps: number[] = [];
  const card = { hidden: false };
  const f = new FeedFilter<typeof card>({
    findCards: () => [card],
    extract: () => ({ videoId: "video01", title: "T", channel: "C" }),
    hide: (c) => { c.hidden = true; },
    show: (c) => { c.hidden = false; },
    send: async () => {
      stamps.push(Date.now());
      if (outcome === "throw") throw new Error("Could not establish connection");
      return outcome === "undefined" ? (undefined as unknown as DecideResponse) : outcome;
    },
  }, TAGS);
  f.schedule();
  // имитируем мутации DOM каждые 5 с: они не должны приводить к лишним отправкам
  for (let t = 0; t < horizonMs; t += 5000) { await vi.advanceTimersByTimeAsync(5000); f.schedule(); }
  await vi.advanceTimersByTimeAsync(1000);
  return { stamps, hidden: card.hidden };
}

describe("повторы отправки", () => {
  const table: Array<[string, Outcome, number[]]> = [
    ["no_key — терминально", { ok: false, error: "no_key" }, [0]],
    ["bad_response — терминально", { ok: false, error: "bad_response" }, [0]],
    ["network — 2 повтора", { ok: false, error: "network" }, [0, 30_000, 150_000]],
    ["rate_limited — 2 повтора", { ok: false, error: "rate_limited" }, [0, 30_000, 150_000]],
    ["исключение sendMessage — 2 повтора", "throw", [0, 30_000, 150_000]],
    ["ответ undefined — терминально", "undefined", [0]],
  ];
  for (const [name, outcome, expected] of table) {
    it(`${name}: точные времена отправок, карточка видима`, async () => {
      const r = await run(outcome);
      expect(r.stamps).toEqual(expected);
      expect(r.stamps.length).toBeLessThanOrEqual(3);
      expect(r.hidden).toBe(false);
    });
  }

  it("успех после временного сбоя: скрывает и дальше не повторяет", async () => {
    let n = 0;
    const stamps: number[] = [];
    const card = { hidden: false };
    const f = new FeedFilter<typeof card>({
      findCards: () => [card],
      extract: () => ({ videoId: "video01", title: "T", channel: "C" }),
      hide: (c) => { c.hidden = true; },
      show: (c) => { c.hidden = false; },
      send: async () => { stamps.push(Date.now()); return n++ === 0 ? { ok: false, error: "network" } : { ok: true, hide: true, matchedTagIds: ["a"], probabilities: {} }; },
    }, TAGS);
    f.schedule();
    await vi.advanceTimersByTimeAsync(400_000);
    expect(stamps).toEqual([0, 30_000]);
    expect(card.hidden).toBe(true);
  });

  it("смена набора тегов сбрасывает терминальность", async () => {
    const stamps: number[] = [];
    const card = { hidden: false };
    const f = new FeedFilter<typeof card>({
      findCards: () => [card],
      extract: () => ({ videoId: "video01", title: "T", channel: "C" }),
      hide: (c) => { c.hidden = true; },
      show: (c) => { c.hidden = false; },
      send: async () => { stamps.push(Date.now()); return { ok: false, error: "no_key" }; },
    }, TAGS);
    f.schedule();
    await vi.advanceTimersByTimeAsync(60_000);
    f.updateSettings({ ...TAGS, tags: [{ id: "a", text: "tag", enabled: true }, { id: "b", text: "other", enabled: true }] });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stamps).toEqual([0, 60_000]);
  });
});
