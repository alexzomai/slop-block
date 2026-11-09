import type { LocalStats } from "../shared/usage";
import type { KV } from "./storage";

export const STATS_STORAGE = "usageStats";
/** Отдельный счётчик TypeSafe (у него нет API баланса). */
export const STATS_STORAGE_TYPESAFE = "usageStatsTypesafe";
export const statsStorage = (provider: "openrouter" | "typesafe"): string => (provider === "typesafe" ? STATS_STORAGE_TYPESAFE : STATS_STORAGE);

interface Stored { day: string; requestsToday: number; tokensToday: number; requestsTotal: number; tokensTotal: number }

export const emptyStats = (): LocalStats => ({ requestsToday: 0, requestsTotal: 0, tokensToday: 0, tokensTotal: 0 });
const nat = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10); // сутки UTC, как usage_daily OpenRouter

function normalize(raw: unknown, today: string): Stored {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const same = r.day === today;
  return {
    day: today,
    requestsToday: same ? nat(r.requestsToday) : 0,
    tokensToday: same ? nat(r.tokensToday) : 0,
    requestsTotal: nat(r.requestsTotal),
    tokensTotal: nat(r.tokensTotal),
  };
}

/** Локальный счётчик запросов Jev. Пишет только background; запись — строго по очереди. */
export function createStats(o: { kv: KV; now: () => number; storage?: string }) {
  const storage = o.storage ?? STATS_STORAGE;
  let queue: Promise<void> = Promise.resolve();
  const load = async () => normalize((await o.kv.get(storage))[storage], dayOf(o.now()));

  return {
    async read(): Promise<LocalStats> {
      try {
        const s = await load();
        return { requestsToday: s.requestsToday, requestsTotal: s.requestsTotal, tokensToday: s.tokensToday, tokensTotal: s.tokensTotal };
      } catch {
        return emptyStats();
      }
    },
    /** Учитывает один оплаченный (2xx) ответ Jev. Никогда не бросает. */
    record(json: unknown): Promise<void> {
      const u = (json as { usage?: { input_tokens?: unknown } } | null)?.usage;
      const t = u?.input_tokens;
      const tokens = typeof t === "number" && Number.isSafeInteger(t) && t >= 0 ? t : 0;
      const run = async (): Promise<void> => {
        try {
          const s = await load();
          s.requestsToday++; s.requestsTotal++;
          s.tokensToday += tokens; s.tokensTotal += tokens;
          await o.kv.set({ [storage]: s });
        } catch {
          // сбой учёта не должен влиять на решение
        }
      };
      const p = queue.then(run);
      queue = p;
      return p;
    },
  };
}
