import type { KV } from "./storage";

export const KEY_STORAGE = "openrouterKey";
export const SETTINGS_STORAGE = "settings";
export const DEFAULT_MODEL = "typesafe/jev-1.13";
export const DEFAULT_THRESHOLD = 0.7;

export interface Settings { model: string; threshold: number }

export async function getKey(kv: KV): Promise<string | undefined> {
  const v = (await kv.get(KEY_STORAGE))[KEY_STORAGE];
  return typeof v === "string" && v.trim() ? v : undefined;
}

export async function setKey(kv: KV, raw: string): Promise<boolean> {
  const key = raw.trim();
  if (!key) return false;
  await kv.set({ [KEY_STORAGE]: key });
  return true;
}

export async function removeKey(kv: KV): Promise<void> {
  await kv.remove(KEY_STORAGE);
}

/** Маска для UI: не более последних 4 символов, короткие ключи не раскрываются. */
export function maskKey(key: string): string {
  return key.length >= 12 ? `…${key.slice(-4)}` : "…";
}

export async function getSettings(kv: KV): Promise<Settings> {
  const raw = (await kv.get(SETTINGS_STORAGE))[SETTINGS_STORAGE] as Partial<Settings> | undefined;
  const model = typeof raw?.model === "string" && raw.model.trim() ? raw.model.trim() : DEFAULT_MODEL;
  const t = raw?.threshold;
  const threshold = typeof t === "number" && Number.isFinite(t) && t >= 0 && t <= 1 ? t : DEFAULT_THRESHOLD;
  return { model, threshold };
}

export async function saveSettings(
  kv: KV,
  input: { model: string; threshold: number },
): Promise<{ ok: true } | { ok: false; code: "model_required" | "threshold_range" }> {
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) return { ok: false, code: "model_required" };
  const t = input.threshold;
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 1) {
    return { ok: false, code: "threshold_range" };
  }
  await kv.set({ [SETTINGS_STORAGE]: { model, threshold: t } });
  return { ok: true };
}
