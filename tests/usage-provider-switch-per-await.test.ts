import { describe, expect, it, vi } from "vitest";
import { createLimiter } from "../src/background/limiter";
import { createUsageService } from "../src/background/usage";
import { fakeKV } from "./helpers/fake";

/**
 * Инвариант (ts-r1 P2-2): смена провайдера (с invalidate, как доставляет storage.onChanged) в ЛЮБОЙ точке ожидания
 * (kv.get/set/remove, fetch, sleep) на пути usage.get() — для КАЖДОЙ ветки (успех/ошибка OpenRouter, no_key OpenRouter,
 * успех/no_key TypeSafe) — не даёт ответ и числа прежнего контекста. Ответ либо относится к новому провайдеру
 * (с его счётчиком), либо это network с пустым счётчиком. Механика как в usage-key-change-per-await: результат
 * операции запоминается, затем (пока вызывающий ждёт) провайдер меняется, и только потом результат возвращается.
 */
const OR_KEY = "or-fixture-key";
const TS_KEY = "ts-fixture-key";
const OR_STATS = { day: "1970-01-01", requestsToday: 9, tokensToday: 900, requestsTotal: 9, tokensTotal: 900 };
const TS_STATS = { day: "1970-01-01", requestsToday: 2, tokensToday: 20, requestsTotal: 2, tokensTotal: 20 };
const OR_LOCAL = { requestsToday: 9, requestsTotal: 9, tokensToday: 900, tokensTotal: 900 };
const TS_LOCAL = { requestsToday: 2, requestsTotal: 2, tokensToday: 20, tokensTotal: 20 };
const ZERO = { requestsToday: 0, requestsTotal: 0, tokensToday: 0, tokensTotal: 0 };
const okBody = JSON.stringify({ data: { usage: 1, usage_daily: 0, usage_monthly: 0, limit: null, limit_remaining: null } });

type Scenario = { name: string; from: "openrouter" | "typesafe"; keys: Record<string, string>; fetchStatus?: number };
const SCENARIOS: Scenario[] = [
  { name: "OpenRouter успех", from: "openrouter", keys: { openrouterKey: OR_KEY, typesafeKey: TS_KEY } },
  { name: "OpenRouter ошибка сети (503 с ретраями)", from: "openrouter", keys: { openrouterKey: OR_KEY, typesafeKey: TS_KEY }, fetchStatus: 503 },
  { name: "OpenRouter no_key", from: "openrouter", keys: { typesafeKey: TS_KEY } },
  { name: "TypeSafe успех", from: "typesafe", keys: { openrouterKey: OR_KEY, typesafeKey: TS_KEY } },
  { name: "TypeSafe no_key", from: "typesafe", keys: { openrouterKey: OR_KEY } },
];

function harness(sc: Scenario, hit: number) {
  const to = sc.from === "openrouter" ? "typesafe" : "openrouter";
  const kv = fakeKV({ ...sc.keys, settings: { provider: sc.from }, usageStats: OR_STATS, usageStatsTypesafe: TS_STATS });
  let calls = 0;
  let fired = false;
  const holder: { svc?: ReturnType<typeof createUsageService> } = {};
  const wrap = <T>(op: () => Promise<T>): Promise<T> =>
    (async () => {
      const result = await op();
      if (++calls === hit) {
        fired = true;
        kv.data.settings = { provider: to };
        holder.svc?.invalidate();
      }
      await Promise.resolve();
      return result;
    })();
  const now = () => 1000;
  const svc = createUsageService({
    kv: {
      get: (k) => wrap(() => kv.get(k)),
      set: (i) => wrap(() => kv.set(i)),
      remove: (k) => wrap(() => kv.remove(k)),
    },
    fetch: vi.fn(() => wrap(async () => new Response(sc.fetchStatus ? "{}" : okBody, { status: sc.fetchStatus ?? 200 }))) as unknown as typeof fetch,
    now,
    sleep: (ms) => wrap(async () => void ms),
    random: () => 0,
    limiter: createLimiter({ maxConcurrent: 4, perMinute: 60, maxQueue: 50, now, sleep: async () => {} }),
  });
  holder.svc = svc;
  return { svc, to, count: () => calls, didFire: () => fired };
}

describe("смена провайдера в каждой точке ожидания usage.get(): устаревший контекст не отдаётся", () => {
  for (const sc of SCENARIOS) {
    it(sc.name, async () => {
      const base = harness(sc, 0);
      await base.svc.get();
      const points = base.count();
      expect(points).toBeGreaterThanOrEqual(3); // перебор не вырожден
      let total = points;
      let fired = 0;
      for (let hit = 1; hit <= total; hit++) {
        const h = harness(sc, hit);
        const r: any = await h.svc.get();
        total = Math.max(total, h.count());
        if (!h.didFire()) continue;
        fired++;
        const expectedLocal = h.to === "typesafe" ? TS_LOCAL : OR_LOCAL;
        const isNewContext = h.to === "typesafe" ? r.provider === "typesafe" : r.provider === undefined;
        if (isNewContext) {
          expect(r.local).toEqual(expectedLocal); // новый провайдер — его числа, не старого
          if (h.to === "typesafe") expect(r).toMatchObject(sc.keys.typesafeKey ? { ok: true, remote: null } : { ok: false, error: "no_key" });
        } else {
          // допустим только безопасный отказ без чужих чисел
          expect(r).toEqual({ ok: false, error: "network", local: ZERO });
        }
        expect(JSON.stringify(r)).not.toMatch(/fixture-key/);
      }
      expect(fired).toBeGreaterThanOrEqual(points);
    });
  }
  it("ровно сценарий ревьюера: OR без ключа, смена на TypeSafe во время чтения usageStats", async () => {
    const kv = fakeKV({ typesafeKey: TS_KEY, settings: { provider: "openrouter" }, usageStats: OR_STATS, usageStatsTypesafe: TS_STATS });
    const get = kv.get.bind(kv);
    let release!: () => void;
    let reading = false;
    const gate = new Promise<void>((r) => (release = r));
    kv.get = async (keys) => {
      if (keys === "usageStats") {
        reading = true;
        await gate;
      }
      return get(keys);
    };
    const now = () => 1000;
    const svc = createUsageService({ kv, fetch: vi.fn() as unknown as typeof fetch, now, sleep: async () => {}, random: () => 0, limiter: createLimiter({ maxConcurrent: 4, perMinute: 60, maxQueue: 50, now, sleep: async () => {} }) });
    const p = svc.get();
    await vi.waitFor(() => expect(reading).toBe(true));
    await kv.set({ settings: { provider: "typesafe" } });
    svc.invalidate();
    release();
    expect(await p).toEqual({ ok: true, remote: null, provider: "typesafe", local: TS_LOCAL });
  });
});
