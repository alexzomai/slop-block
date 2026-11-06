import { getKey, getSettings, maskKey, removeKey, saveSettings, setKey } from "../background/settings";
import type { KV } from "../background/storage";
import type { MsgKey } from "../shared/i18n";

export interface View { keySet: boolean; keyMask: string; model: string; threshold: number }
/** Результат операции: ключ сообщения словаря (текст подбирает UI по языку браузера). */
export interface Result { ok: boolean; key: MsgKey }

export async function loadView(kv: KV): Promise<View> {
  const key = await getKey(kv);
  const s = await getSettings(kv);
  return { keySet: !!key, keyMask: key ? maskKey(key) : "", ...s };
}

export async function onSaveKey(kv: KV, raw: string): Promise<Result> {
  return (await setKey(kv, raw)) ? { ok: true, key: "msg_key_saved" } : { ok: false, key: "msg_key_required" };
}

export async function onRemoveKey(kv: KV): Promise<Result> {
  await removeKey(kv);
  return { ok: true, key: "msg_key_removed" };
}

export async function onSaveSettings(kv: KV, model: string, thresholdRaw: string): Promise<Result> {
  const threshold = thresholdRaw.trim() === "" ? NaN : Number(thresholdRaw);
  const r = await saveSettings(kv, { model, threshold });
  return r.ok ? { ok: true, key: "msg_settings_saved" } : { ok: false, key: r.code === "model_required" ? "err_model_required" : "err_threshold_range" };
}
