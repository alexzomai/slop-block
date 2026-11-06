import type { UsageResponse } from "../shared/usage";
import { emptyStats } from "./stats";

interface OnMessage {
  addListener(cb: (msg: unknown, sender: { id?: string }, sendResponse: (r: unknown) => void) => boolean | void): void;
}

/** Слушатель сообщений: только от своего расширения (sender.id). Прочие типы игнорируются. */
export function registerListener(
  onMessage: OnMessage,
  ownId: string,
  h: { decide(msg: unknown): Promise<unknown>; usage(): Promise<UsageResponse> },
): void {
  onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== ownId) return false;
    const type = typeof msg === "object" && msg !== null ? (msg as { type?: unknown }).type : undefined;
    if (type === "slop/decide") {
      h.decide(msg).then(sendResponse, () => sendResponse({ ok: false, error: "network" }));
      return true;
    }
    if (type === "slop/usage") {
      h.usage().then(sendResponse, () => sendResponse({ ok: false, error: "network", local: emptyStats() }));
      return true;
    }
    return false;
  });
}
