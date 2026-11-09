import { PROVIDERS, parseProvider, type ProviderId } from "./providers";
import type { KV } from "./storage";

/** Ключ OpenRouter (имя не менялось — миграция не нужна); ключ TypeSafe — PROVIDERS.typesafe.keyStorage. */
export const KEY_STORAGE = PROVIDERS.openrouter.keyStorage;
export const TS_KEY_STORAGE = PROVIDERS.typesafe.keyStorage;
export const SETTINGS_STORAGE = "settings";
export const DEFAULT_MODEL = PROVIDERS.openrouter.defaultModel;
export const DEFAULT_MODEL_TYPESAFE = PROVIDERS.typesafe.defaultModel;
export const DEFAULT_THRESHOLD = 0.7;

/** model — модель OpenRouter (прежнее поле), modelTypesafe — модель TypeSafe. */
export interface Settings { provider: ProviderId; model: string; modelTypesafe: string; threshold: number }

export async function getKey(kv: KV, provider: ProviderId = "openrouter"): Promise<string | undefined> {
  const name = PROVIDERS[provider].keyStorage;
  const v = (await kv.get(name))[name];
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Поколение сохранения ключа провайдера: меняется при КАЖДОМ сохранении/удалении, даже если значение ключа то же (не секрет). */
export const keyGenStorage = (provider: ProviderId): string => `${PROVIDERS[provider].keyStorage}Gen`;

export async function getKeyGen(kv: KV, provider: ProviderId): Promise<string> {
  const name = keyGenStorage(provider);
  const v = (await kv.get(name))[name];
  return typeof v === "string" ? v : "";
}

const newGen = (): string => crypto.randomUUID();

export async function setKey(kv: KV, raw: string, provider: ProviderId = "openrouter"): Promise<boolean> {
  const key = raw.trim();
  if (!key) return false;
  // ключ и поколение — одной записью: отметка «ключ отклонён» привязана к поколению и перестаёт действовать
  await kv.set({ [PROVIDERS[provider].keyStorage]: key, [keyGenStorage(provider)]: newGen() });
  return true;
}

export async function removeKey(kv: KV, provider: ProviderId = "openrouter"): Promise<void> {
  await kv.set({ [keyGenStorage(provider)]: newGen() });
  await kv.remove(PROVIDERS[provider].keyStorage);
}

/** Маска для UI: не более последних 4 символов, короткие ключи не раскрываются. */
export function maskKey(key: string): string {
  return key.length >= 12 ? `…${key.slice(-4)}` : "…";
}

const modelOr = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);

export async function getSettings(kv: KV): Promise<Settings> {
  const raw = (await kv.get(SETTINGS_STORAGE))[SETTINGS_STORAGE] as Partial<Settings> | undefined;
  const t = raw?.threshold;
  const threshold = typeof t === "number" && Number.isFinite(t) && t >= 0 && t <= 1 ? t : DEFAULT_THRESHOLD;
  return {
    provider: parseProvider(raw?.provider),
    model: modelOr(raw?.model, DEFAULT_MODEL),
    modelTypesafe: modelOr(raw?.modelTypesafe, DEFAULT_MODEL_TYPESAFE),
    threshold,
  };
}

/** Модель активного провайдера. */
export const activeModel = (s: Settings): string => (s.provider === "typesafe" ? s.modelTypesafe : s.model);

/** Поля provider/modelTypesafe необязательны: не заданные сохраняют текущее значение. */
export async function saveSettings(
  kv: KV,
  input: { model: string; threshold: number; provider?: ProviderId; modelTypesafe?: string },
): Promise<{ ok: true } | { ok: false; code: "model_required" | "threshold_range" }> {
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) return { ok: false, code: "model_required" };
  const t = input.threshold;
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 1) {
    return { ok: false, code: "threshold_range" };
  }
  const cur = await getSettings(kv);
  const tsRaw = input.modelTypesafe === undefined ? cur.modelTypesafe : input.modelTypesafe.trim();
  if (!tsRaw) return { ok: false, code: "model_required" };
  const provider = input.provider === undefined ? cur.provider : parseProvider(input.provider);
  await kv.set({ [SETTINGS_STORAGE]: { provider, model, modelTypesafe: tsRaw, threshold: t } });
  return { ok: true };
}

/** Ключ и поколение — одним чтением хранилища (согласованный снимок: setKey пишет их одной записью). */
export async function getKeyWithGen(kv: KV, provider: ProviderId): Promise<{ key: string | undefined; gen: string }> {
  const kn = PROVIDERS[provider].keyStorage;
  const gn = keyGenStorage(provider);
  const r = await kv.get([kn, gn]);
  const k = r[kn];
  return { key: typeof k === "string" && k.trim() ? k : undefined, gen: typeof r[gn] === "string" ? (r[gn] as string) : "" };
}
