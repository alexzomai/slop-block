import { formatInt, formatUsd, t, type MsgKey } from "../shared/i18n";
import type { LocalStats, UsageResponse } from "../shared/usage";

/** Цена Jev, долларов за 1 млн входных токенов (openrouter.ai, typesafe/jev-1.13). Оценка, не счёт. */
export const JEV_USD_PER_MTOK = 0.042;

const MESSAGES: Record<"loading" | "no_key" | "network" | "rate_limited" | "bad_response", MsgKey> = {
  loading: "usage_loading",
  no_key: "usage_no_key",
  network: "usage_network",
  rate_limited: "usage_rate_limited",
  bad_response: "usage_bad_response",
};

export function estimateUsd(tokens: number): number {
  return (tokens * JEV_USD_PER_MTOK) / 1_000_000;
}

export interface UsageView {
  state: "loading" | "no_key" | "error" | "ok";
  text?: string;
  rows?: Array<[string, string]>;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const validLocal = (l: unknown): l is LocalStats =>
  typeof l === "object" && l !== null && ["requestsToday", "requestsTotal", "tokensToday", "tokensTotal"].every((k) => isNum((l as Record<string, unknown>)[k]));

function localRows(l: LocalStats): Array<[string, string]> {
  return [
    [t("usage_requests_today"), formatInt(l.requestsToday)],
    [t("usage_tokens"), t("usage_pair", formatInt(l.tokensToday), formatInt(l.tokensTotal))],
  ];
}

/** Описание блока «Траты» по ответу background (null — ещё грузится). Все строки — только для textContent. */
export function usageView(r: UsageResponse | null | undefined): UsageView {
  const msg = (k: keyof typeof MESSAGES): string => t(MESSAGES[k]);
  if (r === null) return { state: "loading", text: msg("loading") };
  if (typeof r !== "object" || !validLocal(r.local)) {
    return { state: "error", text: r && typeof r === "object" && "ok" in r ? msg("bad_response") : msg("network") };
  }
  if (!r.ok) {
    if (r.error === "no_key") return { state: "no_key", text: msg("no_key"), rows: localRows(r.local) };
    const text = r.error === "network" || r.error === "rate_limited" || r.error === "bad_response" ? msg(r.error) : msg("bad_response");
    return { state: "error", text, rows: localRows(r.local) };
  }
  const x = r.remote;
  if (!x || ![x.usage, x.usageDaily, x.usageMonthly].every(isNum)) return { state: "error", text: msg("bad_response") };
  const rows: Array<[string, string]> = [[t("usage_today"), formatUsd(x.usageDaily)], [t("usage_total"), formatUsd(x.usage)]];
  if (isNum(x.limitRemaining)) rows.push([t("usage_limit_remaining"), formatUsd(x.limitRemaining)]);
  rows.push(...localRows(r.local), [t("usage_jev_estimate"), formatUsd(estimateUsd(r.local.tokensTotal))]);
  return { state: "ok", rows };
}
