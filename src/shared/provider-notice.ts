import { PROVIDER_STATUS_TYPE } from "./ui-messages";
import { t, type MsgKey } from "./i18n";

/** Текст проблемы провайдера для popup/options по ответу `slop/provider-status`; null — блок скрыт (ok, ошибка, неверный вид ответа). */
export function providerNotice(r: unknown): string | null {
  if (typeof r !== "object" || r === null) return null;
  const v = r as { ok?: unknown; provider?: unknown; state?: unknown };
  if (v.ok !== true) return null;
  const ts = v.provider === "typesafe";
  const key: MsgKey | null = v.state === "no_credits" ? (ts ? "provider_no_credits_typesafe" : "provider_no_credits") : v.state === "access_denied" ? "provider_access_denied" : null;
  return key ? t(key) : null;
}

/** Запрос состояния у background; любой сбой → null (fail-open: блок скрыт). */
export async function loadProviderNotice(): Promise<string | null> {
  try {
    return providerNotice(await chrome.runtime.sendMessage({ type: PROVIDER_STATUS_TYPE }));
  } catch {
    return null;
  }
}

/** Показывает/скрывает элемент; текст — только textContent. */
export function showProviderNotice(el: HTMLElement, text: string | null): void {
  el.textContent = text ?? "";
  el.hidden = text === null;
}
