import type { ProviderId } from "../background/providers";
import { getKey, getSettings, maskKey, removeKey, saveSettings, setKey } from "../background/settings";
import type { KV } from "../background/storage";
import type { MsgKey } from "../shared/i18n";

export interface KeyView { keySet: boolean; keyMask: string }
export interface View extends KeyView {
  /** keySet/keyMask — ключ OpenRouter (прежние поля); ключ TypeSafe — в typesafe. */
  typesafe: KeyView;
  provider: ProviderId;
  model: string;
  modelTypesafe: string;
  threshold: number;
}
/** Результат операции: ключ сообщения словаря (текст подбирает UI по языку браузера). */
export interface Result { ok: boolean; key: MsgKey }

async function keyView(kv: KV, provider: ProviderId): Promise<KeyView> {
  const key = await getKey(kv, provider);
  return { keySet: !!key, keyMask: key ? maskKey(key) : "" };
}

export async function loadView(kv: KV): Promise<View> {
  const s = await getSettings(kv);
  return { ...(await keyView(kv, "openrouter")), typesafe: await keyView(kv, "typesafe"), ...s };
}

export async function onSaveKey(kv: KV, raw: string, provider: ProviderId = "openrouter"): Promise<Result> {
  return (await setKey(kv, raw, provider)) ? { ok: true, key: "msg_key_saved" } : { ok: false, key: "msg_key_required" };
}

export async function onRemoveKey(kv: KV, provider: ProviderId = "openrouter"): Promise<Result> {
  await removeKey(kv, provider);
  return { ok: true, key: "msg_key_removed" };
}

export async function onSaveSettings(kv: KV, model: string, thresholdRaw: string, provider?: ProviderId, modelTypesafe?: string): Promise<Result> {
  const threshold = thresholdRaw.trim() === "" ? NaN : Number(thresholdRaw);
  const r = await saveSettings(kv, { model, threshold, provider, modelTypesafe });
  return r.ok ? { ok: true, key: "msg_settings_saved" } : { ok: false, key: r.code === "model_required" ? "err_model_required" : "err_threshold_range" };
}
