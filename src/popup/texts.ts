import { t, type MsgKey } from "../shared/i18n";
import type { Mode } from "../shared/settings";

const KEYS: Record<Mode, { placeholder: MsgKey; title: MsgKey; label: MsgKey }> = {
  allowlist: { placeholder: "popup_placeholder_allowlist", title: "popup_title_allowlist", label: "popup_input_label_allowlist" },
  blocklist: { placeholder: "popup_placeholder_blocklist", title: "popup_title_blocklist", label: "popup_input_label_blocklist" },
};

/** Подписи popup, зависящие от режима фильтра, на языке браузера. */
export function modeTexts(mode: Mode): { placeholder: string; title: string; label: string } {
  const k = KEYS[mode];
  return { placeholder: t(k.placeholder), title: t(k.title), label: t(k.label) };
}
