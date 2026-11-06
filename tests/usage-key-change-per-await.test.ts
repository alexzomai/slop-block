import { describe, expect, it, vi } from "vitest";
import { createLimiter } from "../src/background/limiter";
import { createUsageService } from "../src/background/usage";
import { fakeKV } from "./helpers/fake";

const A = "fixture-key-A";
const B = "fixture-key-B";
const body = (usage: number) => JSON.stringify({ data: { usage, usage_daily: 0, usage_monthly: 0, limit: null, limit_remaining: null } });

type Change = "to_B" | "delete";

/**
 * ЧТО ПОКРЫВАЕТ ЭТОТ ТЕСТ (и чего нет). Перебирается ОДНА смена ключа за прогон, по очереди в каждой точке ожидания,
 * которая реально достигается на пути get() и проходит через инструментированные обёртки KV (get/set/remove), fetch
 * и sleep. Не покрыто: не-инструментированные ожидания (например, чтение тела Response, голые Promise),
 * комбинации нескольких смен на повторных проходах (A→B→A в разных точках одного вызова), точки, недостижимые
 * в базовом прогоне. Точки повторных проходов перебираются, но смена в каждом прогоне всё равно одна.
 * Финальная точка (последнее чтение ключа) проверяется с invalidate (как в production, где onChanged
 * доставляется всегда); без invalidate в ней защита опирается только на onChanged и здесь не проверяется.
 *
 * Механика: каждый await на пути get() (kv.get/set/remove, fetch, sleep) — «точка ожидания». В точке №hit операция выполняется,
 * её результат запоминается, затем (пока вызывающий ещё ждёт) ключ меняется на B или удаляется, и только потом результат
 * возвращается вызывающему — то есть вызывающий получает данные, снятые ДО смены. Точки считаются автоматически
 * по вызовам обёрток.
 */
function harness(opts: { hit: number; change: Change; invalidate: boolean }) {
  const kv = fakeKV({ openrouterKey: A });
  let calls = 0;
  let armed = true;
  let fired = false;
  const wrap = <T>(op: () => Promise<T>): Promise<T> =>
    (async () => {
      const result = await op();
      if (armed && ++calls === opts.hit) {
        fired = true;
        if (opts.change === "to_B") kv.data.openrouterKey = B;
        else delete kv.data.openrouterKey;
        if (opts.invalidate) holder.svc?.invalidate();
      }
      await Promise.resolve();
      return result;
    })();
  const count = () => calls;
  const didFire = () => fired;
  const holder: { svc?: ReturnType<typeof createUsageService> } = {};
  const wkv = {
    get: (k: string | string[]) => wrap(() => kv.get(k)),
    set: (i: Record<string, unknown>) => wrap(() => kv.set(i)),
    remove: (k: string | string[]) => wrap(() => kv.remove(k)),
  };
  const fetchImpl = vi.fn((_u: unknown, init: RequestInit) =>
    wrap(async () => {
      const k = (init.headers as Record<string, string>).Authorization!.slice(7);
      return new Response(body(k === A ? 1 : 2));
    }),
  );
  const now = () => 1000;
  const svc = createUsageService({
    kv: wkv,
    fetch: fetchImpl as unknown as typeof fetch,
    now,
    sleep: (ms) => wrap(async () => void ms),
    random: () => 0,
    limiter: createLimiter({ maxConcurrent: 4, perMinute: 60, maxQueue: 50, now, sleep: async () => {} }),
  });
  holder.svc = svc;
  return {
    svc,
    kv,
    count,
    didFire,
    /** прогрев: заполнить кэш ключом A без вмешательства, затем обнулить счётчик и вооружиться */
    async prime() {
      armed = false;
      await svc.get();
      armed = true;
      calls = 0;
    },
  };
}

const NEVER_A = (r: any, change: Change) => {
  if (r.ok) {
    expect(change).toBe("to_B");
    expect(r.remote.usage).toBe(2); // данные B; 1 — это A
  } else {
    expect(["no_key", "network"]).toContain(r.error);
  }
  expect(JSON.stringify(r)).not.toContain(A);
};

describe("одиночная смена ключа в каждой достижимой точке ожидания (KV/fetch/sleep): ответ — данные B или ошибка, не A", () => {
  for (const warm of [false, true]) {
    for (const change of ["to_B", "delete"] as Change[]) {
      for (const invalidate of [false, true]) {
        it(`${warm ? "тёплый" : "холодный"} кэш, ${change}, ${invalidate ? "с" : "без"} invalidate — в КАЖДОЙ точке ожидания`, async () => {
          const baseline = harness({ hit: 0, change, invalidate });
          if (warm) await baseline.prime();
          await baseline.svc.get();
          const points = baseline.count();
          expect(points).toBeGreaterThanOrEqual(warm ? 3 : 5); // перебор не вырожден

          let total = points;
          let fired = 0;
          for (let hit = 1; hit <= total; hit++) {
            const h = harness({ hit, change, invalidate });
            if (warm) await h.prime();
            const r = await h.svc.get();
            // Последняя точка (финальное чтение ключа): без invalidate снимок A уже получен вызывающим, и защищает
            // только доставка onChanged → invalidate; поэтому там проверяем лишь режим с invalidate (как в production).
            // точка, которой в этом прогоне не оказалось (индекс выше числа операций), смены не вызвала — проверять нечего
            if (h.didFire()) {
              fired++;
              if (hit < h.count() || invalidate) NEVER_A(r, change);
            }
            total = Math.max(total, h.count()); // повторные проходы добавляют точки — их тоже перебираем
          }
          expect(fired).toBeGreaterThanOrEqual(points); // все достижимые точки базового прогона реально сработали
        });
      }
    }
  }
});

describe("регрессия r2 (ревьюер): смена ключа во время stats.read", () => {
  it("invalidate во время чтения usageStats — данные B, не A", async () => {
    const kv = fakeKV({ openrouterKey: A });
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
    const f = vi.fn(async (_u: unknown, init: RequestInit) => new Response(body((init.headers as Record<string, string>).Authorization === `Bearer ${A}` ? 1 : 2)));
    const svc = createUsageService({ kv, fetch: f as unknown as typeof fetch, now, sleep: async () => {}, random: () => 0, limiter: createLimiter({ maxConcurrent: 4, perMinute: 60, maxQueue: 50, now, sleep: async () => {} }) });
    const p = svc.get();
    await vi.waitFor(() => expect(reading).toBe(true));
    await kv.set({ openrouterKey: B });
    svc.invalidate();
    release();
    const r: any = await p;
    expect(r.ok).toBe(true);
    expect(r.remote.usage).toBe(2);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("контроль: A→B→A во время HTTP — свежее поколение", async () => {
    const kv = fakeKV({ openrouterKey: A });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const now = () => 1000;
    const svc = createUsageService({
      kv,
      fetch: (async () => { if (++calls === 1) { await gate; return new Response(body(1)); } return new Response(body(7)); }) as unknown as typeof fetch,
      now, sleep: async () => {}, random: () => 0,
      limiter: createLimiter({ maxConcurrent: 4, perMinute: 60, maxQueue: 50, now, sleep: async () => {} }),
    });
    const p = svc.get();
    await vi.waitFor(() => expect(calls).toBe(1));
    await kv.set({ openrouterKey: B }); svc.invalidate();
    await kv.set({ openrouterKey: A }); svc.invalidate();
    release();
    expect(await p).toMatchObject({ ok: true, remote: { usage: 7 } });
    expect(calls).toBe(2);
  });
});
