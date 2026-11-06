// ТОЛЬКО для тестовой сборки (dist-test/): детерминированная замена боевого background.
// Скрывает видео, чей заголовок содержит слово из текста любого тега; заголовок "ERR" → network.
// globalThis.__forceError (no_key|network|bad_response|rate_limited) заставляет отвечать ошибкой;
// globalThis.__delay задерживает ответ (мс);
// globalThis.__calls накапливает videoId всех запросов (e2e проверяет «0 запросов» на подписках).
import type { DecideRequest, DecideResponse } from "../shared/decision";
import { tagIdentity } from "../shared/settings";
import type { UsageResponse } from "../shared/usage";

// Маркер: по нему тест убеждается, что заглушка не попала в боевую сборку.
(globalThis as Record<string, unknown>).__SLOP_TEST_STUB__ = true;

export type ForcedError = "no_key" | "network" | "bad_response" | "rate_limited";

export function decide(req: DecideRequest, forceError?: ForcedError): DecideResponse {
  if (forceError) return { ok: false, error: forceError };
  if (req.video.title === "ERR") return { ok: false, error: "network" };
  const title = req.video.title.toLowerCase();
  const matched = req.tags.filter((t) => tagIdentity(t.text).split(/\s+/).some((w) => w.length > 2 && title.includes(w)));
  return {
    ok: true,
    hide: matched.length > 0,
    matchedTagIds: matched.map((t) => t.id),
    probabilities: Object.fromEntries(req.tags.map((t) => [t.id, matched.includes(t) ? 1 : 0])),
  };
}

/** Фиксированные траты для e2e popup (набор tags). */
export function usage(): UsageResponse {
  return {
    ok: true,
    remote: { usage: 0.0123, usageDaily: 0.0004, usageMonthly: 0.01, limit: 100, limitRemaining: 74.5 },
    local: { requestsToday: 3, requestsTotal: 10, tokensToday: 1500, tokensTotal: 12345 },
  };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    const m = msg as Partial<DecideRequest> | null;
    if ((msg as { type?: unknown } | null)?.type === "slop/usage") {
      sendResponse(usage());
      return false;
    }
    if (m?.type !== "slop/decide" || !m.video || !m.tags) return false;
    const g = globalThis as { __calls?: string[]; __forceError?: ForcedError; __delay?: number };
    (g.__calls ??= []).push(m.video.videoId);
    const answer = decide(m as DecideRequest, g.__forceError);
    if (!g.__delay) {
      sendResponse(answer);
      return false;
    }
    setTimeout(() => sendResponse(answer), g.__delay); // e2e: проверить состояние «ответа ещё нет»
    return true;
  });
}
