import type { DecideRequest, DecideResponse, PeekRequest, PeekResponse } from "../shared/decision";
import { isSearchPath, isSubscriptionsPath } from "../shared/paths";
import type { Settings } from "../shared/settings";
import { loadSettings, subscribeSettings } from "../shared/storage";
import { Autofill } from "./autofill";
import { createHider, createRevealer, hideCard, revealCard, showCard, unrevealCard } from "./dom";
import { CONTINUATION_SELECTOR, HOLD_ATTR, PEEK_ATTR, createHold, findContinuation, IndicatorView, measureFilled, reenter, restoreScroll } from "./feed";
import { FeedFilter } from "./filter";
import { markLoaded } from "./mark";
import { extractMeta, findCards } from "./selectors";

const root = document.documentElement;
const GATE = "data-slop-gate";
const HOLD = HOLD_ATTR;
const WATCHDOG_MS = 3000;
const AUTOFILL_DELAY_MS = 250;

markLoaded(root);
// Синхронно, до первой отрисовки карточек: шлюз allowlist взведён (gate.css скрывает карточки без решения).
// Настройки ещё не прочитаны — следующий шаг приведёт атрибут к реальному состоянию; любой сбой его снимает.
root.setAttribute(GATE, "allowlist");
// Удержание continuation (HOLD) взводит только контроллер после проверки геометрии; failOpen и watchdog снимают оба атрибута.
const failOpen = (): void => {
  root.removeAttribute(GATE);
  root.removeAttribute(HOLD);
};
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
  const hider = createHider<Element>({ hide: (c) => hideCard(c as HTMLElement), show: (c) => showCard(c as HTMLElement) });
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
      hide: (c) => hider.hide(c),
      show: (c) => hider.show(c),
      allow: (c, instant) => revealer.allow(c, instant),
      disallow: (c) => revealer.disallow(c),
      setGate: (on) => (on ? root.setAttribute(GATE, "allowlist") : root.removeAttribute(GATE)),
      send: (req: DecideRequest) => chrome.runtime.sendMessage(req) as Promise<DecideResponse>,
      peek: (req: PeekRequest) => chrome.runtime.sendMessage(req) as Promise<PeekResponse>,
    },
    current,
    { onSubscriptions: onSubs(), onSearch: onSearch() },
  );
  const setHold = createHold(
    root,
    () => {
      const se = document.scrollingElement;
      return se ? { height: se.scrollHeight, top: se.scrollTop, left: se.scrollLeft } : { height: 0, top: 0, left: 0 };
    },
    () => findContinuation(document) !== null,
    () => {
      return [...document.querySelectorAll(CONTINUATION_SELECTOR)].every((c) => {
        if (c.hasAttribute(PEEK_ATTR)) return true; // наш inline transform reenter, а не страничный
        const cs = getComputedStyle(c);
        return cs.transform === "none" && cs.translate === "none" && cs.rotate === "none" && cs.scale === "none" && cs.position === "static";
      });
    },
    (g) => {
      const se = document.scrollingElement;
      if (se) restoreScroll(se, g);
    },
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
    hold: setHold,
    liveCards: () => findCards(document).length,
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
  autofill.observe(); // исходное число карточек фиксируется в момент подключения наблюдателя, до окна дебаунса
  new MutationObserver(() => {
    try {
      if (location.pathname !== path) reconfigure();
      autofill.onDomChange(); // синхронно: удержание continuation возвращается до первого кадра
      filter.schedule();
    } catch {
      failOpen();
    }
  }).observe(root, { childList: true, subtree: true });
  // Жест пользователя после остановки по лимиту: новый ограниченный бюджет (скрипт событий не создаёт: isTrusted).
  const intent = (e: Event): void => {
    if (e.isTrusted) autofill.userIntent();
  };
  window.addEventListener("wheel", intent, { passive: true });
  window.addEventListener("touchmove", intent, { passive: true });
  window.addEventListener(
    "keydown",
    (e) => {
      if (["PageDown", "End", "ArrowDown", " ", "Spacebar"].includes(e.key)) intent(e);
    },
    { passive: true },
  );
  filter.schedule();
}

void main().catch(() => {
  failOpen(); // нет доступа к storage/runtime — страница остаётся нетронутой
});
