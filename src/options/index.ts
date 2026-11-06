import { applyI18n, domRoot, t } from "../shared/i18n";
import { loadView, onRemoveKey, onSaveKey, onSaveSettings } from "./controller";
import type { Result } from "./controller";

const kv = chrome.storage.local;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

applyI18n(domRoot(document), "options_title");

function say(id: string, r: Result): void {
  const el = $(id);
  el.textContent = t(r.key);
  el.dataset.ok = String(r.ok);
}

async function render(): Promise<void> {
  const v = await loadView(kv);
  $("key-status").textContent = v.keySet ? t("options_key_saved_masked", v.keyMask) : t("options_key_not_set");
  $<HTMLInputElement>("model").value = v.model;
  $<HTMLInputElement>("threshold").value = String(v.threshold);
}

$("save-key").addEventListener("click", async () => {
  const input = $<HTMLInputElement>("key");
  const r = await onSaveKey(kv, input.value);
  if (r.ok) input.value = "";
  say("key-msg", r);
  await render();
});
$("remove-key").addEventListener("click", async () => {
  $<HTMLInputElement>("key").value = "";
  say("key-msg", await onRemoveKey(kv));
  await render();
});
$("save-settings").addEventListener("click", async () => {
  say("settings-msg", await onSaveSettings(kv, $<HTMLInputElement>("model").value, $<HTMLInputElement>("threshold").value));
  await render();
});

void render();
