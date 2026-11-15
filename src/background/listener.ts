import { OPEN_OPTIONS_TYPE, PROVIDER_STATUS_TYPE } from "../shared/ui-messages";
import type { UsageResponse } from "../shared/usage";
import { emptyStats } from "./stats";

interface OnMessage {
  addListener(cb: (msg: unknown, sender: { id?: string }, sendResponse: (r: unknown) => void) => boolean | void): void;
}

/** Слушатель сообщений: только от своего расширения (sender.id). Прочие типы игнорируются. */
export function registerListener(
  onMessage: OnMessage,
  ownId: string,
  h: { decide(msg: unknown): Promise<unknown>; peek?(msg: unknown): Promise<unknown>; usage(): Promise<UsageResponse>; openOptions?(): void; providerStatus?(): Promise<unknown> },
): void {
  onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== ownId) return false;
    const type = typeof msg === "object" && msg !== null ? (msg as { type?: unknown }).type : undefined;
    if (type === "slop/decide") {
      h.decide(msg).then(sendResponse, () => sendResponse({ ok: false, error: "network" }));
      return true;
    }
    if (type === "slop/peek" && h.peek) {
      h.peek(msg).then(sendResponse, () => sendResponse({ ok: false, error: "bad_response" }));
      return true;
    }
    if (type === OPEN_OPTIONS_TYPE && h.openOptions) {
      try {
        h.openOptions();
      } catch {
        /* настройки не открылись: индикатор остаётся, ничего не ломается */
      }
      sendResponse({ ok: true });
      return false;
    }
    if (type === PROVIDER_STATUS_TYPE && h.providerStatus) {
      h.providerStatus().then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    }
    if (type === "slop/usage") {
      h.usage().then(sendResponse, () => sendResponse({ ok: false, error: "network", local: emptyStats() }));
      return true;
    }
    return false;
  });
}
