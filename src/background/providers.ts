import { ENDPOINT as OPENROUTER_ENDPOINT } from "./jev";

/** Провайдеры Jev (System One). Формат тела и ответа у них общий; различаются адрес, ключ, модель и API баланса. См. design.md, D1. */
export type ProviderId = "openrouter" | "typesafe";

export interface Provider {
  id: ProviderId;
  endpoint: string;
  /** Ключ в chrome.storage.local (TRUSTED_CONTEXTS). */
  keyStorage: string;
  defaultModel: string;
  /** Есть ли у провайдера документированный API баланса/расходов. */
  hasBalanceApi: boolean;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  openrouter: { id: "openrouter", endpoint: OPENROUTER_ENDPOINT, keyStorage: "openrouterKey", defaultModel: "typesafe/jev-1.13", hasBalanceApi: true },
  typesafe: { id: "typesafe", endpoint: "https://api.typesafe.ai/v1/systemone", keyStorage: "typesafeKey", defaultModel: "jev-1.13.0", hasBalanceApi: false },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function parseProvider(v: unknown): ProviderId {
  return v === "typesafe" ? "typesafe" : "openrouter";
}

/** Базовая модель, чьи ключи кэша остаются в прежнем формате. */
const BASE_MODEL = "jev-1.13";

/** Каноническая версия модели: без префикса typesafe/, без патча «.0». */
export function canonicalModel(model: string): string {
  return model.trim().toLowerCase().replace(/^typesafe\//, "").replace(/^(jev-\d+\.\d+)\.0$/, "$1");
}

/** Пространство кэша решений: "" для базовой модели (старый формат ключей), иначе каноническая модель. Провайдер не входит. */
export function cacheNamespace(model: string): string {
  const c = canonicalModel(model);
  return c === BASE_MODEL ? "" : c;
}
