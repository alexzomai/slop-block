import type { RemoteUsage, UsageResponse } from "../shared/usage";
import { callJev } from "./client";
import type { createLimiter } from "./limiter";
import { createRejections } from "./rejected";
import { getKey, getKeyWithGen, getSettings } from "./settings";
import { createStats, emptyStats, statsStorage } from "./stats";
import type { KV } from "./storage";

/** GET /api/v1/key — данные текущего ключа. См. design.md, D1. */
export const KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";
export const CACHE_MS = 60_000;
/** Сколько раз повторять проход, если ключ/поколение сменились во время ответа. */
export const MAX_PASSES = 3;

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const numOrNull = (v: unknown): number | null | undefined => (v === null ? null : num(v) ? v : undefined);

/** Берёт из ответа только пять числовых полей; всё прочее (label, budgets…) отбрасывается. */
export function parseKeyInfo(json: unknown): RemoteUsage | null {
  const d = (json as { data?: unknown } | null)?.data as Record<string, unknown> | undefined;
  if (typeof d !== "object" || d === null) return null;
  const limit = numOrNull(d.limit);
  const limitRemaining = numOrNull(d.limit_remaining);
  if (!num(d.usage) || !num(d.usage_daily) || !num(d.usage_monthly) || limit === undefined || limitRemaining === undefined) return null;
  return { usage: d.usage, usageDaily: d.usage_daily, usageMonthly: d.usage_monthly, limit, limitRemaining };
}

export interface UsageServiceOptions {
  kv: KV;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  limiter: ReturnType<typeof createLimiter>;
  /** Общая с decide память об отклонённых ключах; иначе создаётся своя. */
  rejections?: ReturnType<typeof createRejections>;
}

type Remote = { ok: true; remote: RemoteUsage } | { ok: false; error: "no_key" | "key_rejected" | "rate_limited" | "network" | "bad_response" };

export function createUsageService(o: UsageServiceOptions) {
  const stats = createStats({ kv: o.kv, now: o.now });
  const statsTs = createStats({ kv: o.kv, now: o.now, storage: statsStorage("typesafe") });
  const rejections = o.rejections ?? createRejections(o.kv);
  // Контракт: ответ, полученный с ключом K, не показывается, если текущий сохранённый ключ ≠ K.
  // Ключ K хранится только в памяти background (сравнение полным значением, без отпечатков) и наружу не отдаётся.
  // gen растёт при любом изменении ключа (invalidate); кэш и in-flight привязаны к (K, gen).
  let gen = 0;
  let cached: { key: string; gen: number; at: number; remote: RemoteUsage } | undefined;
  let inflight: { key: string; gen: number; p: Promise<Remote> } | undefined;

  async function fetchRemote(key: string, g: number, keyGen: string): Promise<Remote> {
    const res = await callJev({ fetch: o.fetch, key, url: KEY_ENDPOINT, method: "GET", sleep: o.sleep, random: o.random, schedule: o.limiter.run });
    if (!res.ok) {
      if (res.error === "key_rejected") await rejections.mark("openrouter", key, keyGen).catch(() => undefined);
      return { ok: false, error: res.error };
    }
    const remote = parseKeyInfo(res.json);
    if (!remote) return { ok: false, error: "bad_response" };
    // Результат кэшируется только если ни ключ, ни поколение не менялись за время запроса.
    if (g === gen && (await getKey(o.kv)) === key) cached = { key, gen: g, at: o.now(), remote };
    return { ok: true, remote };
  }

  /** Remote для ключа key: из кэша или запросом (async). Сам по себе ничего не гарантирует о «текущем» ключе. */
  async function obtain(key: string, g: number, keyGen: string): Promise<Remote> {
    const age = cached ? o.now() - cached.at : Infinity;
    if (cached && cached.key === key && cached.gen === g && age >= 0 && age < CACHE_MS) return { ok: true, remote: cached.remote };
    if (!inflight || inflight.key !== key || inflight.gen !== g) {
      const p: Promise<Remote> = fetchRemote(key, g, keyGen).finally(() => {
        if (inflight?.p === p) inflight = undefined;
      });
      inflight = { key, gen: g, p };
    }
    return inflight.p;
  }

  return {
    /** Ключ изменён/удалён (chrome.storage.onChanged): сбросить кэш и отбросить ответы в полёте. */
    invalidate(): void {
      gen++;
      cached = undefined;
      inflight = undefined;
    },
    /**
     * ИНВАРИАНТ: у get() ОДНА точка возврата данных — последняя строка прохода — и она общая для ВСЕХ веток
     * (успех и ошибка OpenRouter, no_key, успех TypeSafe). Ветки лишь собирают кандидата (candidate) вместе со снимком
     * контекста (provider, key, gen). После всего асинхронного (чтение настроек и ключа, fetch, stats.read, повторное
     * чтение провайдера и ключа) проверка «провайдер, ключ и gen не менялись» — синхронная и последняя операция:
     * между ней и return нет ни одного await. Не прошла → проход повторяется (до MAX_PASSES); при исчерпании —
     * ошибка network с пустым счётчиком: ни ответ, ни числа прежнего контекста не отдаются.
     */
    async get(): Promise<UsageResponse> {
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        try {
          const g = gen;
          const provider = (await getSettings(o.kv)).provider;
          const { key, gen: keyGen } = await getKeyWithGen(o.kv, provider);
          let candidate: UsageResponse;
          if (provider === "typesafe") {
            // У TypeSafe нет API баланса (design.md, D5): сети нет, только наличие ключа и локальный счётчик.
            const local = await statsTs.read();
            candidate = !key
              ? { ok: false, error: "no_key", provider: "typesafe", local }
              : (await rejections.has("typesafe", key, keyGen))
                ? { ok: false, error: "key_rejected", provider: "typesafe", local }
                : { ok: true, remote: null, provider: "typesafe", local };
          } else if (!key) {
            cached = undefined;
            candidate = { ok: false, error: "no_key", local: await stats.read() }; // данных ключа нет — утечь нечему
          } else if (await rejections.has("openrouter", key, keyGen)) {
            candidate = { ok: false, error: "key_rejected", local: await stats.read() }; // без запроса: ключ уже отвергнут
          } else {
            const remote = await obtain(key, g, keyGen);
            const local = await stats.read();
            candidate = remote.ok ? { ok: true, remote: remote.remote, local } : { ok: false, error: remote.error, local };
          }
          const providerNow = (await getSettings(o.kv)).provider;
          const current = await getKey(o.kv, provider); // последнее чтение перед проверкой
          // --- после этой строки await запрещён ---
          if (providerNow === provider && current === key && g === gen) return candidate;
        } catch {
          // сбой чтения хранилища: повторить проход / исчерпать
        }
      }
      return { ok: false, error: "network", local: emptyStats() };
    },
  };
}
