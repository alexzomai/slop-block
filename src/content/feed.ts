// DOM-адаптер автодогрузки: единственное место, знающее про continuation YouTube, заполненность и индикатор.
// Деградация безопасна: нет continuation — нет подгрузки; любая ошибка гасится контроллером.
import { t, type MsgKey } from "../shared/i18n";
import type { Indicator } from "./autofill";

/**
 * Запас за нижней границей окна. 0: пока низ последней видимой карточки не вышел за окно, continuation
 * (он идёт сразу за карточками) в зоне видимости; дальше он вне окна, и это штатная ситуация для прокрутки пользователя.
 */
export const FILL_MARGIN = 0;
export const CONTINUATION_SELECTOR = "ytd-continuation-item-renderer";
export const SHOWN_CARD_SELECTOR = "[data-slop-show]";
export const INDICATOR_ID = "slop-feed-status";
const SAFETY_MS = 500;

/** Ключи словаря (static/_locales) для состояний индикатора. */
export const INDICATOR_KEYS: Record<Exclude<Indicator, "off">, MsgKey> = {
  searching: "autofill_searching",
  exhausted: "autofill_exhausted",
  unsafe: "autofill_unsafe",
};
/** Текст индикатора на языке браузера (в DOM только через textContent). */
export const indicatorText = (state: Exclude<Indicator, "off">): string => t(INDICATOR_KEYS[state]);

/** Низы видимых карточек относительно окна; пусто — не заполнено. */
export function isFilled(bottoms: number[], innerHeight: number): boolean {
  return bottoms.length > 0 && Math.max(...bottoms) >= innerHeight + FILL_MARGIN;
}

export function findContinuation(doc: Pick<Document, "querySelectorAll">): HTMLElement | null {
  const all = doc.querySelectorAll<HTMLElement>(CONTINUATION_SELECTOR);
  return all.length > 0 ? all[all.length - 1]! : null;
}

export function measureFilled(doc: Pick<Document, "querySelectorAll">, innerHeight: number): boolean {
  const bottoms: number[] = [];
  for (const el of doc.querySelectorAll(SHOWN_CARD_SELECTOR)) {
    const r = el.getBoundingClientRect();
    if (r.height > 0) bottoms.push(r.bottom);
  }
  return isFilled(bottoms, innerHeight);
}

interface StyledLike {
  style: { getPropertyValue(n: string): string; getPropertyPriority(n: string): string; setProperty(n: string, v: string, p?: string): void; removeProperty(n: string): string };
  getBoundingClientRect(): { top: number; bottom: number };
  setAttribute?(n: string, v: string): void;
  removeAttribute?(n: string): void;
}
/** Маркер собственного inline transform reenter: проверка plain у удержания его не считает страничным. */
export const PEEK_ATTR = "data-slop-peek";
export interface Geometry { height: number; top: number; left: number }
export type ReenterResult = "ok" | "unsafe";
export interface ReenterEnv {
  raf(cb: () => void): void;
  timeout(cb: () => void, ms: number): void;
  dispatch(name: "scroll" | "resize"): void;
  height(): number;
  /** Снимок геометрии прокрутки документа; чтение принудительно считает раскладку (layout flush). */
  geometry(): Geometry;
  /** Откат собственного побочного эффекта: вернуть позицию прокрутки к снимку. Не прокрутка пользователя. */
  restore(g: Geometry): void;
}
/** Насколько вглубь окна заводим continuation, если он был за его нижней границей. */
const PEEK_PX = 60;

const same = (a: Geometry, b: Geometry): boolean => a.height === b.height && a.top === b.top && a.left === b.left;

/**
 * Повторный вход continuation в зону видимости. ИНВАРИАНТ: ни в одном отрисованном кадре scrollHeight/scrollTop/
 * scrollLeft документа не отличаются от значений до триггера; если сохранить геометрию невозможно, триггер не
 * применяется. Контракт не зависит от CSS страницы и строится на измерении, а не на предположениях:
 *  1. снимок геометрии до применения;
 *  2. применяем inline `transform: translateY(<отрицательное>)` и в той же задаче (до отрисовки) читаем геометрию
 *     (layout flush); если она изменилась (например, страничный transform/overflow перекрыт нашим), немедленно в
 *     той же задаче откатываем transform и восстанавливаем позицию к снимку (откат собственного побочного
 *     эффекта, не прокрутка пользователя) и возвращаем "unsafe": триггер для этой страницы не применяется;
 *  3. через 2 кадра перед снятием transform (внутри rAF, до отрисовки) меряем геометрию, снимаем и меряем снова
 *     в той же задаче; если снятие что-то изменило, восстанавливаем позицию к значению до снятия и сообщаем
 *     onUnsafe (изменения самой страницы между измерениями, например пришедшая порция, нарушением не считаются).
 * Механика (какие события видит IntersectionObserver YouTube): continuation в окне на два кадра уходит выше
 * верхней границы окна и возвращается (выход, вход); ниже окна на два кадра заводится в окно на PEEK_PX и
 * возвращается (вход); выше окна не двигается. Затем scroll/resize на window; страховка таймером 500 мс.
 */
export function reenter(el: StyledLike, env: ReenterEnv = defaultEnv(), onUnsafe: () => void = () => {}): ReenterResult {
  const prevValue = el.style.getPropertyValue("transform");
  const prevPriority = el.style.getPropertyPriority("transform");
  const snap = env.geometry();
  const h = env.height();
  const r = el.getBoundingClientRect();
  let done = false;
  let released = false;
  const putBack = (): void => {
    el.removeAttribute?.(PEEK_ATTR);
    el.style.removeProperty("transform");
    if (prevValue) el.style.setProperty("transform", prevValue, prevPriority);
  };
  /** Снять наш transform, измерив до и после в одной задаче. */
  const release = (): void => {
    if (released) return;
    released = true;
    const pre = env.geometry();
    putBack();
    const post = env.geometry();
    if (!same(pre, post)) {
      if (post.top !== pre.top || post.left !== pre.left) {
        env.restore(pre);
        env.geometry(); // перечитываем после отката в той же задаче; неравенство снимку состояния не меняет: триггер уже unsafe
      }
      onUnsafe();
    }
  };
  const finish = (): void => {
    if (done) return;
    done = true;
    release();
    env.dispatch("scroll");
    env.dispatch("resize");
  };
  const shift = (px: number): void => {
    el.setAttribute?.(PEEK_ATTR, "1");
    el.style.setProperty("transform", `translateY(${-px}px)`, "important");
  };
  if (r.bottom <= 0) {
    env.timeout(finish, SAFETY_MS);
    finish(); // выше окна: не двигаем
    return "ok";
  }
  shift(r.top >= h ? Math.ceil(r.top - (h - PEEK_PX)) : Math.ceil(r.bottom) + 1);
  if (!same(env.geometry(), snap)) {
    done = true;
    released = true;
    putBack();
    const after = env.geometry(); // flush: раскладка вернулась, браузер мог уже ограничить scrollTop
    if (after.top !== snap.top || after.left !== snap.left) {
      env.restore(snap);
      env.geometry(); // перечитываем после отката в той же задаче; триггер в любом случае unsafe, повторов нет
    }
    return "unsafe";
  }
  env.timeout(finish, SAFETY_MS);
  if (r.top >= h) {
    env.raf(() => env.raf(finish));
    return "ok";
  }
  env.raf(() =>
    env.raf(() => {
      if (done) return;
      release(); // вход: снимаем transform
      env.raf(() => env.raf(finish));
    }),
  );
  return "ok";
}

/**
 * Откат позиции прокрутки к снимку. Только scrollTo с behavior "instant": он перекрывает CSS scroll-behavior
 * (smooth на html/body), тогда как присваивание scrollTop/scrollLeft при smooth запускает анимацию вместо возврата.
 */
export function restoreScroll(se: { scrollTo(o: ScrollToOptions): void }, g: Geometry): void {
  se.scrollTo({ top: g.top, left: g.left, behavior: "instant" });
}

function defaultEnv(): ReenterEnv {
  return {
    raf: (cb) => void requestAnimationFrame(cb),
    timeout: (cb, ms) => void setTimeout(cb, ms),
    dispatch: (name) => void window.dispatchEvent(new Event(name)),
    height: () => window.innerHeight,
    geometry: () => {
      const se = document.scrollingElement;
      return se ? { height: se.scrollHeight, top: se.scrollTop, left: se.scrollLeft } : { height: 0, top: 0, left: 0 };
    },
    restore: (g) => {
      const se = document.scrollingElement;
      if (se) restoreScroll(se, g);
    },
  };
}

/** Индикатор внизу ленты: один элемент перед continuation, только textContent. */
export class IndicatorView {
  private el: HTMLElement | undefined;

  set(state: Indicator, doc: Document = document): void {
    if (state === "off") {
      if (this.el) this.el.hidden = true;
      return;
    }
    const cont = findContinuation(doc);
    const parent = cont?.parentElement;
    if (!cont || !parent) {
      if (this.el) this.el.hidden = true;
      return;
    }
    if (!this.el) {
      this.el = doc.createElement("div");
      this.el.id = INDICATOR_ID;
      this.el.setAttribute("role", "status");
    }
    if (this.el.nextElementSibling !== cont || this.el.parentElement !== parent) parent.insertBefore(this.el, cont);
    this.el.dataset.state = state;
    this.el.textContent = indicatorText(state);
    this.el.hidden = false;
  }
}

export const HOLD_ATTR = "data-slop-hold";

/**
 * Переключатель удержания continuation (атрибут на <html>, смещение делает CSS). ИНВАРИАНТ: удержание не меняет
 * геометрию документа и позицию прокрутки. Каждое переключение измеряется в одной задаче (до/после); при каждом
 * включении дополнительно проверяется `plain` (у ВСЕХ continuation нет своего transform/позиционирования). Если
 * включение изменило высоту документа, удержание откатывается, позиция прокрутки возвращается к снимку (браузер мог
 * ограничить scrollTop при временном сжатии документа) и удержание отключается до перезагрузки страницы. Снятие,
 * изменившее позицию, тоже откатывается к снимку.
 */
export function createHold(
  root: { setAttribute(n: string, v: string): void; removeAttribute(n: string): void },
  geometry: () => Geometry,
  hasContinuation: () => boolean,
  plain: () => boolean = () => true,
  /** Откат собственного побочного эффекта: вернуть позицию прокрутки к снимку (не прокрутка пользователя). */
  restore: (g: Geometry) => void = () => {},
): (on: boolean) => void {
  let broken = false;
  let applied = false;
  const put = (on: boolean): void => {
    applied = on;
    if (on) root.setAttribute(HOLD_ATTR, "1");
    else root.removeAttribute(HOLD_ATTR);
  };
  const fixScroll = (snap: Geometry): void => {
    const now = geometry();
    if (now.top !== snap.top || now.left !== snap.left) {
      restore(snap);
      geometry(); // перечитываем после отката в той же задаче
    }
  };
  return (on) => {
    if (broken || !on) {
      // снятие безусловно (стартовый атрибут мог быть взведён снаружи); позиция сохраняется
      const snap = geometry();
      put(false);
      fixScroll(snap);
      return;
    }
    if (applied) return;
    if (!hasContinuation() || !plain()) return; // перекрыли бы страничный transform или проверять не на чем
    put(false);
    const before = geometry();
    put(true);
    const after = geometry();
    if (before.height !== after.height || before.left !== after.left) {
      broken = true;
      put(false);
      geometry(); // раскладка вернулась; теперь возвращаем позицию, которую браузер мог ограничить
      fixScroll(before);
      return;
    }
    fixScroll(before);
  };
}
