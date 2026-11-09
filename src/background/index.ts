import { createDecider } from "./decide";
import { registerListener } from "./listener";
import { createLimiter } from "./limiter";
import { KEY_STORAGE, SETTINGS_STORAGE, TS_KEY_STORAGE, keyGenStorage } from "./settings";
import { createRejections } from "./rejected";
import { createUsageService } from "./usage";

const kv = chrome.storage.local;

// Ключи OpenRouter и TypeSafe не должны быть виден content script (тот живёт на youtube.com).
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

const deps = {
  kv,
  fetch: (...a: Parameters<typeof fetch>) => globalThis.fetch(...a),
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  random: Math.random,
};
// Единый бюджет запросов ко всем провайдерам (OpenRouter, TypeSafe): Jev и запрос трат делят один лимитер.
const limiter = createLimiter({ maxConcurrent: 6, perMinute: 60, maxQueue: 50, now: deps.now, sleep: deps.sleep });
const rejections = createRejections(kv);
void rejections.purgeLegacy(); // устаревший общий ключ keyRejected (формат только этой ветки) удаляется без переноса
const decide = createDecider({ ...deps, limiter, rejections });
const usage = createUsageService({ ...deps, limiter, rejections });

// Смена/удаление любого ключа или провайдера (в любом контексте) сбрасывает кэш трат и отбрасывает ответы в полёте.
// Повторное сохранение того же ключа меняет поколение (keyGen) — событие приходит и тогда, и отметка «отклонён» перестаёт действовать.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (KEY_STORAGE in changes || TS_KEY_STORAGE in changes || keyGenStorage("openrouter") in changes || keyGenStorage("typesafe") in changes || SETTINGS_STORAGE in changes) usage.invalidate();
});

registerListener(chrome.runtime.onMessage, chrome.runtime.id, { decide, peek: decide.peek, usage: () => usage.get() });
