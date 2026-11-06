export interface UsageRequest { type: "slop/usage" }
/** Данные ключа OpenRouter, в долларах. limit/limitRemaining — null, если лимита нет. Только числа. */
export interface RemoteUsage { usage: number; usageDaily: number; usageMonthly: number; limit: number | null; limitRemaining: number | null }
/** Локальный счётчик расширения (сутки UTC). */
export interface LocalStats { requestsToday: number; requestsTotal: number; tokensToday: number; tokensTotal: number }
export type UsageError = "no_key" | "rate_limited" | "network" | "bad_response";
export type UsageResponse =
  | { ok: true; remote: RemoteUsage; local: LocalStats }
  | { ok: false; error: UsageError; local: LocalStats };
