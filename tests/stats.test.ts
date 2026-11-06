import { describe, expect, it } from "vitest";
import { createStats, emptyStats } from "../src/background/stats";
import { fakeKV } from "./helpers/fake";

const DAY1 = Date.UTC(2026, 10, 6, 12);
const DAY2 = Date.UTC(2026, 10, 7, 0, 0, 1);

describe("stats", () => {
  it("пусто → нули", async () => {
    expect(await createStats({ kv: fakeKV(), now: () => DAY1 }).read()).toEqual(emptyStats());
  });
  it("считает запрос и input_tokens", async () => {
    const s = createStats({ kv: fakeKV(), now: () => DAY1 });
    await s.record({ usage: { input_tokens: 476, output_tokens: 70 } });
    await s.record({ usage: { input_tokens: 24 } });
    expect(await s.read()).toEqual({ requestsToday: 2, requestsTotal: 2, tokensToday: 500, tokensTotal: 500 });
  });
  it.each([[undefined], [{}], [{ usage: {} }], [{ usage: { input_tokens: -1 } }], [{ usage: { input_tokens: 1.5 } }], [{ usage: { input_tokens: "5" } }], [null]])(
    "нет валидных токенов (%j) → запрос считается, токены нет", async (json) => {
      const s = createStats({ kv: fakeKV(), now: () => DAY1 });
      await s.record(json);
      expect(await s.read()).toEqual({ requestsToday: 1, requestsTotal: 1, tokensToday: 0, tokensTotal: 0 });
    });
  it("смена суток UTC обнуляет «сегодня», total сохраняется", async () => {
    let t = DAY1;
    const s = createStats({ kv: fakeKV(), now: () => t });
    await s.record({ usage: { input_tokens: 10 } });
    t = DAY2;
    expect(await s.read()).toEqual({ requestsToday: 0, requestsTotal: 1, tokensToday: 0, tokensTotal: 10 });
    await s.record({ usage: { input_tokens: 5 } });
    expect(await s.read()).toEqual({ requestsToday: 1, requestsTotal: 2, tokensToday: 5, tokensTotal: 15 });
  });
  it("мусор в storage → нули, запись не падает", async () => {
    const kv = fakeKV({ usageStats: { day: 5, requestsToday: "x", tokensTotal: -3 } });
    const s = createStats({ kv, now: () => DAY1 });
    expect(await s.read()).toEqual(emptyStats());
    await s.record({ usage: { input_tokens: 7 } });
    expect(await s.read()).toEqual({ requestsToday: 1, requestsTotal: 1, tokensToday: 7, tokensTotal: 7 });
  });
  it("параллельные record не теряют обновления", async () => {
    const s = createStats({ kv: fakeKV(), now: () => DAY1 });
    await Promise.all(Array.from({ length: 20 }, () => s.record({ usage: { input_tokens: 1 } })));
    expect((await s.read()).requestsTotal).toBe(20);
  });
  it("сбой записи: record не бросает, следующий работает", async () => {
    const kv = fakeKV();
    let fail = true;
    const orig = kv.set.bind(kv);
    kv.set = async (i) => { if (fail) throw new Error("quota"); return orig(i); };
    const s = createStats({ kv, now: () => DAY1 });
    await expect(s.record({ usage: { input_tokens: 1 } })).resolves.toBeUndefined();
    fail = false;
    await s.record({ usage: { input_tokens: 2 } });
    expect((await s.read()).requestsTotal).toBe(1);
  });
});
