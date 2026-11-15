// DOM-адаптер автодогрузки: единственное место, знающее про continuation YouTube, заполненность и индикатор.
// Деградация безопасна: нет continuation — нет подгрузки; любая ошибка гасится контроллером.
import { t, type MsgKey } from "../shared/i18n";
import type { Failure, Indicator, IndicatorInfo } from "./autofill";
import { findCards } from "./selectors";

/**
 * Запас за нижней границей окна. 0: пока низ последней видимой карточки не вышел за окно, continuation
 * (он идёт сразу за карточками) в зоне видимости; дальше он вне окна, и это штатная ситуация для прокрутки пользователя.
 */
export const FILL_MARGIN = 0;
export const CONTINUATION_SELECTOR = "ytd-continuation-item-renderer";
export const SHOWN_CARD_SELECTOR = "[data-slop-show]";
export const INDICATOR_ID = "slop-feed-status";
const SAFETY_MS = 500;

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

/** Карточка реально отображается: ненулевой размер (display:none у себя или предка даёт 0) и не visibility:hidden. */
export function isRendered(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cv = (el as { checkVisibility?: (o?: { visibilityProperty?: boolean }) => boolean }).checkVisibility;
  return typeof cv === "function" ? cv.call(el, { visibilityProperty: true }) : true;
}

/**
 * Число отображаемых показанных карточек (по уникальным видео). Показанные нами карточки могут не быть видны
 * пользователю: их прячет чужой CSS/расширение, они лежат в скрытой странице SPA (YouTube держит прежние страницы в DOM
 * с display:none) — такие в цель не засчитываются.
 */
export function countRenderedShown(doc: Pick<Document, "querySelectorAll">, idOf: (el: Element) => string | null): number {
  const keys = new Set<unknown>();
  for (const el of doc.querySelectorAll(SHOWN_CARD_SELECTOR)) {
    if (!isRendered(el)) continue;
    keys.add(idOf(el) ?? el);
  }
  return keys.size;
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

/** Индикатор внизу ленты: один блок перед continuation (или после последней карточки, если его нет), только textContent. */
export const MORE_ID = "slop-feed-more";
export const SETTINGS_ID = "slop-feed-settings";

export interface IndicatorTexts { title: string; detail: string }

const FAILURE_KEYS: Record<Failure, MsgKey> = {
  no_key: "autofill_error_no_key",
  rate_limited: "autofill_error_rate_limited",
  network: "autofill_error_network",
  bad_response: "autofill_error_bad_response",
  no_credits: "autofill_error_no_credits",
  access_denied: "autofill_error_access_denied",
};

/** Заголовок и пояснение состояния (чистая функция: тексты из словаря, подстановки — только числа и коды). */
export function indicatorTexts(state: Exclude<Indicator, "off">, info: IndicatorInfo): IndicatorTexts {
  switch (state) {
    case "searching":
      return { title: t("autofill_searching"), detail: t("autofill_progress", info.found, info.target, info.checked) };
    case "done":
      return { title: t("autofill_done", info.found), detail: t("autofill_done_hint") };
    case "exhausted": {
      let title: string;
      if (info.reason === "empty" && info.sinceGrowth > 0) title = t("autofill_stop_empty", info.sinceGrowth);
      else if (info.reason === "total") title = t("autofill_stop_total", info.checked, info.found, info.target);
      else if (info.reason === "stall") title = t("autofill_stop_stall");
      else title = t("autofill_stop_nofeed"); // потолок ожидания и порции, которые не приходят
      return { title, detail: t("autofill_stop_hint") };
    }
    case "end":
      return { title: t("autofill_end"), detail: t("autofill_end_detail", info.found, info.checked) };
    case "unsafe":
      return { title: t("autofill_unsafe"), detail: "" };
    case "error":
      return { title: t("autofill_error", t(FAILURE_KEYS[info.failure ?? "no_key"])), detail: t(info.failure === "no_key" || info.failure === "no_credits" || info.failure === "access_denied" || info.failure === null ? "autofill_error_hint" : "autofill_error_hint_retry") };
  }
}

export class IndicatorView {
  private el: HTMLElement | undefined;
  private title: HTMLElement | undefined;
  private detail: HTMLElement | undefined;
  private fill: HTMLElement | undefined;
  private bar: HTMLElement | undefined;
  private more: HTMLButtonElement | undefined;
  private settings: HTMLButtonElement | undefined;

  /** onMore — явная просьба «искать дальше» (кнопка при остановке; единственный путь там, где прокрутки нет); onSettings — открыть настройки. */
  constructor(
    private onMore: () => void = () => {},
    private onSettings: () => void = () => {},
  ) {}

  private hide(): void {
    if (this.el) this.el.hidden = true;
  }

  private build(doc: Document): HTMLElement {
    const mk = (tag: string, cls?: string): HTMLElement => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      return e;
    };
    const button = (id: string, label: MsgKey, cls: string, onClick: () => void): HTMLButtonElement => {
      const b = doc.createElement("button");
      b.id = id;
      b.type = "button";
      b.className = cls;
      b.textContent = t(label);
      b.hidden = true;
      b.addEventListener("click", (e) => {
        if (e.isTrusted) onClick(); // скрипт страницы бюджет не выдаёт и настройки не открывает
      });
      return b;
    };
    const el = mk("div");
    el.id = INDICATOR_ID;
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-atomic", "true");
    const icon = mk("span", "slop-fs-icon");
    icon.setAttribute("aria-hidden", "true");
    const body = mk("div", "slop-fs-body");
    this.title = mk("div", "slop-fs-title");
    this.detail = mk("div", "slop-fs-detail");
    this.bar = mk("div", "slop-fs-bar");
    this.bar.setAttribute("aria-hidden", "true");
    this.fill = mk("span", "slop-fs-fill");
    this.bar.append(this.fill);
    body.append(this.title, this.detail);
    const actions = mk("div", "slop-fs-actions");
    this.more = button(MORE_ID, "autofill_more", "slop-fs-btn slop-fs-primary", this.onMore);
    this.settings = button(SETTINGS_ID, "autofill_settings", "slop-fs-btn", this.onSettings);
    actions.append(this.more, this.settings);
    // внешний блок — контейнер для container query (раскладка по ширине самого блока), карточка внутри
    const card = mk("div", "slop-fs-card");
    card.append(icon, body, actions, this.bar);
    el.append(card);
    return el;
  }

  set(state: Indicator, info: IndicatorInfo, doc: Document = document): void {
    if (state === "off") return this.hide();
    // Якорь: перед continuation (новые карточки YouTube вставляет перед ним); нет continuation — после последней карточки.
    const cont = findContinuation(doc);
    let parent: Element | null | undefined = cont?.parentElement;
    let lastCard: Element | undefined;
    if (!cont) {
      const cards = findCards(doc);
      lastCard = cards[cards.length - 1];
      parent = lastCard?.parentElement;
    }
    if (!parent) return this.hide();
    this.el ??= this.build(doc);
    const el = this.el;
    const ordered = el.parentElement === parent && (cont ? el.nextElementSibling === cont : el.previousElementSibling === lastCard);
    if (!ordered) parent.insertBefore(el, cont ?? lastCard!.nextSibling);
    const tx = indicatorTexts(state, info);
    const set = (n: HTMLElement | undefined, v: string): void => {
      if (n && n.textContent !== v) n.textContent = v; // без лишних мутаций и повторных объявлений скринридера
    };
    set(this.title, tx.title);
    set(this.detail, tx.detail);
    // Счётчики прогресса видны, но скринридеру не объявляются на каждом тике: объявляется смена состояния (заголовок и пояснение).
    if (this.detail) {
      if (state === "searching") this.detail.setAttribute("aria-hidden", "true");
      else this.detail.removeAttribute("aria-hidden");
    }
    if (this.bar) this.bar.hidden = state !== "searching";
    if (this.fill) this.fill.style.setProperty("--slop-p", `${info.target > 0 ? Math.min(100, Math.round((info.found / info.target) * 100)) : 0}%`);
    if (this.more) this.more.hidden = state !== "exhausted";
    if (this.settings) this.settings.hidden = state !== "error";
    if (el.dataset.state !== state) el.dataset.state = state;
    el.hidden = false;
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
