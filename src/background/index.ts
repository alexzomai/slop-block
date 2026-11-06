import { createDecider } from "./decide";
import { registerListener } from "./listener";
import { createLimiter } from "./limiter";
import { KEY_STORAGE } from "./settings";
import { createUsageService } from "./usage";

const kv = chrome.storage.local;

// Ключ OpenRouter не должен быть виден content script (тот живёт на youtube.com).
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

const deps = {
  kv,
  fetch: (...a: Parameters<typeof fetch>) => globalThis.fetch(...a),
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  random: Math.random,
};
// Единый бюджет запросов к OpenRouter: Jev и запрос трат делят один лимитер.
const limiter = createLimiter({ maxConcurrent: 4, perMinute: 60, maxQueue: 50, now: deps.now, sleep: deps.sleep });
const decide = createDecider({ ...deps, limiter });
const usage = createUsageService({ ...deps, limiter });

// Смена/удаление ключа (в любом контексте) сбрасывает кэш трат и отбрасывает ответы в полёте.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && KEY_STORAGE in changes) usage.invalidate();
});

registerListener(chrome.runtime.onMessage, chrome.runtime.id, { decide, usage: () => usage.get() });
