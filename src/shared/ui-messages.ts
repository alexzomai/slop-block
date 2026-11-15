// Сообщения интерфейса content → background, не входящие в контракт решений (decision.ts).
/** Открыть страницу настроек расширения (индикатор ленты при ошибке фильтра). Без данных. */
export const OPEN_OPTIONS_TYPE = "slop/open-options";
export interface OpenOptionsRequest { type: typeof OPEN_OPTIONS_TYPE }

/** Состояние активного провайдера для popup/options: пауза после 402/403. Только от своего расширения; без ключа и текстов ответа. */
export const PROVIDER_STATUS_TYPE = "slop/provider-status";
export interface ProviderStatusRequest { type: typeof PROVIDER_STATUS_TYPE }
export type ProviderStatus = { ok: true; provider: "openrouter" | "typesafe"; state: "ok" | "no_credits" | "access_denied" };
