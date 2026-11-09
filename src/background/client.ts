import { ENDPOINT } from "./jev";
import { LimiterFullError } from "./limiter";

export type CallError = "no_key" | "key_rejected" | "rate_limited" | "network" | "bad_response";
export type CallResult = { ok: true; json: unknown } | { ok: false; error: CallError };

export interface CallOptions {
  fetch: typeof fetch;
  key: string;
  /** Для GET не задаётся. */
  body?: unknown;
  /** По умолчанию ENDPOINT (Jev). */
  url?: string;
  /** По умолчанию POST. */
  method?: "GET" | "POST";
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  /** Единый бюджет (лимитер): КАЖДАЯ попытка fetch, включая ретраи, проходит через него. */
  schedule?: <T>(fn: () => Promise<T>) => Promise<T>;
  maxAttempts?: number;
  timeoutMs?: number;
}

const BASE_DELAY = 500;
const MAX_RETRY_AFTER = 10_000;

type Attempt =
  | { kind: "ok"; json: unknown }
  | { kind: "final"; error: CallError }
  | { kind: "retry"; error: CallError; retryAfter?: number };

/** Одна попытка: один дедлайн на fetch И полное чтение тела. Слот бюджета держится только на время попытки. */
async function attempt(o: CallOptions): Promise<Attempt> {
  const method = o.method ?? "POST";
  const ctl = new AbortController();
  const aborted = new Promise<never>((_, reject) => {
    ctl.signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
  });
  aborted.catch(() => undefined);
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 15_000);
  try {
    let res: Response;
    let text: string;
    try {
      res = await Promise.race([
        o.fetch(o.url ?? ENDPOINT, {
          method,
          headers: method === "GET" ? { Authorization: `Bearer ${o.key}` } : { Authorization: `Bearer ${o.key}`, "Content-Type": "application/json" },
          ...(method === "GET" ? {} : { body: JSON.stringify(o.body) }),
          signal: ctl.signal,
        }),
        aborted,
      ]);
      const status = res.status;
      if (!(status >= 200 && status < 300)) {
        void res.body?.cancel().catch(() => undefined);
        if (status === 401 || status === 403) return { kind: "final", error: "key_rejected" };
        if (status === 429 || status >= 500) {
          const ra = Number(res.headers.get("retry-after"));
          const retryAfter = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, MAX_RETRY_AFTER) : undefined;
          return { kind: "retry", error: status === 429 ? "rate_limited" : "network", retryAfter };
        }
        return { kind: "final", error: "bad_response" };
      }
      text = await Promise.race([res.text(), aborted]);
    } catch {
      // abort, таймаут, сетевой обрыв (в том числе при чтении тела)
      return { kind: "retry", error: "network" };
    }
    try {
      return { kind: "ok", json: JSON.parse(text) };
    } catch {
      return { kind: "final", error: "bad_response" };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Вызов API с ретраями 429/5xx. Не логирует и не возвращает тело/заголовки/текст исключений. */
export async function callJev(o: CallOptions): Promise<CallResult> {
  const attempts = o.maxAttempts ?? 3;
  const schedule = o.schedule ?? (<T>(fn: () => Promise<T>) => fn());
  let last: CallError = "network";
  for (let n = 0; n < attempts; n++) {
    let a: Attempt;
    try {
      a = await schedule(() => attempt(o));
    } catch (e) {
      return { ok: false, error: e instanceof LimiterFullError ? "rate_limited" : "network" };
    }
    if (a.kind === "ok") return { ok: true, json: a.json };
    if (a.kind === "final") return { ok: false, error: a.error };
    last = a.error;
    if (n < attempts - 1) {
      await o.sleep(a.retryAfter ?? Math.min(BASE_DELAY * 2 ** n * (1 + o.random() * 0.5), MAX_RETRY_AFTER));
    }
  }
  return { ok: false, error: last };
}
