import type { ProviderId } from "../background/providers";
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
  $("ts-key-status").textContent = v.typesafe.keySet ? t("options_key_saved_masked", v.typesafe.keyMask) : t("options_key_not_set");
  $<HTMLSelectElement>("provider").value = v.provider;
  $<HTMLInputElement>("model").value = v.model;
  $<HTMLInputElement>("model-typesafe").value = v.modelTypesafe;
  $<HTMLInputElement>("threshold").value = String(v.threshold);
}

// Секция ключа провайдера: ids без префикса — OpenRouter, с префиксом ts- — TypeSafe.
function wireKey(provider: ProviderId, prefix: string): void {
  $(`${prefix}save-key`).addEventListener("click", async () => {
    const input = $<HTMLInputElement>(`${prefix}key`);
    const r = await onSaveKey(kv, input.value, provider);
    if (r.ok) input.value = "";
    say(`${prefix}key-msg`, r);
    await render();
  });
  $(`${prefix}remove-key`).addEventListener("click", async () => {
    $<HTMLInputElement>(`${prefix}key`).value = "";
    say(`${prefix}key-msg`, await onRemoveKey(kv, provider));
    await render();
  });
}
wireKey("openrouter", "");
wireKey("typesafe", "ts-");

$("save-settings").addEventListener("click", async () => {
  const provider = $<HTMLSelectElement>("provider").value === "typesafe" ? "typesafe" : "openrouter";
  say("settings-msg", await onSaveSettings(kv, $<HTMLInputElement>("model").value, $<HTMLInputElement>("threshold").value, provider, $<HTMLInputElement>("model-typesafe").value));
  await render();
});

void render();
