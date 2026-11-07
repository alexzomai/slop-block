import type { DecideRequest, DecideResponse } from "../shared/decision";
import { isSearchPath, isSubscriptionsPath } from "../shared/paths";
import type { Settings } from "../shared/settings";
import { loadSettings, subscribeSettings } from "../shared/storage";
import { Autofill } from "./autofill";
import { createRevealer, hideCard, revealCard, showCard, unrevealCard } from "./dom";
import { findContinuation, IndicatorView, measureFilled, reenter } from "./feed";
import { FeedFilter } from "./filter";
import { markLoaded } from "./mark";
import { extractMeta, findCards } from "./selectors";

const root = document.documentElement;
const GATE = "data-slop-gate";
const WATCHDOG_MS = 3000;
const AUTOFILL_DELAY_MS = 250;

markLoaded(root);
// Синхронно, до первой отрисовки карточек: шлюз allowlist взведён (gate.css скрывает карточки без решения).
// Настройки ещё не прочитаны — следующий шаг приведёт атрибут к реальному состоянию; любой сбой его снимает.
root.setAttribute(GATE, "allowlist");
const failOpen = (): void => root.removeAttribute(GATE);
const watchdog = setTimeout(failOpen, WATCHDOG_MS);

const onSubs = (): boolean => isSubscriptionsPath(location.pathname);
const onSearch = (): boolean => isSearchPath(location.pathname);

async function main(): Promise<void> {
  let current: Settings = await loadSettings(chrome.storage.sync);
  clearTimeout(watchdog);
  const revealer = createRevealer<Element>({
    reveal: (c, i) => revealCard(c as HTMLElement, i),
    hide: (c) => unrevealCard(c as HTMLElement),
  });
  const view = new IndicatorView();
  let autofillTimer: ReturnType<typeof setTimeout> | undefined;
  // Дебаунс: после раскрытия карточек (REVEAL_BATCH_MS) и раскладки; сам evaluate() решений не принимает.
  const evaluateSoon = (delay = AUTOFILL_DELAY_MS): void => {
    if (autofillTimer !== undefined) return;
    autofillTimer = setTimeout(() => {
      autofillTimer = undefined;
      autofill.evaluate();
    }, delay);
  };
  const filter: FeedFilter<Element> = new FeedFilter<Element>(
    {
      onSettled: () => evaluateSoon(),
      context: () => ({ onSubscriptions: onSubs(), onSearch: onSearch() }),
      findCards: () => findCards(document),
      extract: (c) => extractMeta(c),
      hide: (c) => hideCard(c as HTMLElement),
      show: (c) => showCard(c as HTMLElement),
      allow: (c) => revealer.allow(c),
      disallow: (c) => revealer.disallow(c),
      setGate: (on) => (on ? root.setAttribute(GATE, "allowlist") : root.removeAttribute(GATE)),
      send: (req: DecideRequest) => chrome.runtime.sendMessage(req) as Promise<DecideResponse>,
    },
    current,
    { onSubscriptions: onSubs(), onSearch: onSearch() },
  );
  const autofill = new Autofill({
    snapshot: () => {
      const f = filter.snapshot();
      return {
        eligible: f.active && f.mode === "allowlist",
        target: current.feedTarget,
        visible: f.visible,
        cards: f.cards,
        pending: f.pending,
        filled: measureFilled(document, window.innerHeight),
        hasContinuation: findContinuation(document) !== null,
      };
    },
    trigger: () => {
      const c = findContinuation(document);
      return c ? reenter(c, undefined, () => autofill.markUnsafe()) : "ok";
    },
    indicator: (state) => view.set(state),
    now: () => Date.now(),
    wake: (ms) => setTimeout(() => evaluateSoon(0), ms + 50),
  });
  let path = location.pathname;
  const reconfigure = (): void => {
    path = location.pathname;
    // Бюджет подгрузок сбрасывается только при реальной смене настроек или страницы.
    autofill.resetIfChanged(`${path}|${JSON.stringify(current)}|${onSubs()}|${onSearch()}`);
    try {
      filter.reconfigure(current, { onSubscriptions: onSubs(), onSearch: onSearch() });
    } catch {
      failOpen();
    }
  };
  reconfigure();
  let seq = 0;
  subscribeSettings(chrome.storage.onChanged, () => {
    const mine = ++seq; // устаревшие чтения игнорируются
    void loadSettings(chrome.storage.sync).then((s) => {
      if (mine !== seq) return;
      current = s;
      reconfigure();
    }, failOpen);
  });
  // SPA: события YouTube + страховка при каждом проходе наблюдателя (одно сравнение строк).
  // Ранние сигналы перехода: контекст пересчитывается до finish (иначе старые ответы действуют в окне перехода).
  const early = (): void => {
    try {
      filter.syncContext();
    } catch {
      failOpen();
    }
  };
  document.addEventListener("yt-navigate-start", early);
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener("currententrychange", early);
  document.addEventListener("yt-navigate-finish", reconfigure);
  window.addEventListener("popstate", reconfigure);
  // Следим только за childList: собственное скрытие меняет атрибуты и цикла не вызывает.
  new MutationObserver(() => {
    try {
      if (location.pathname !== path) reconfigure();
      filter.schedule();
    } catch {
      failOpen();
    }
  }).observe(root, { childList: true, subtree: true });
  filter.schedule();
}

void main().catch(() => {
  failOpen(); // нет доступа к storage/runtime — страница остаётся нетронутой
});
