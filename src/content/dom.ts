export interface Hideable {
  style: { getPropertyValue(n: string): string; setProperty(n: string, v: string, p?: string): void; removeProperty(n: string): string };
  setAttribute(n: string, v: string): void;
  removeAttribute(n: string): void;
}

/** Скрывает карточку, не удаляя её из DOM; прежний inline display запоминается. */
export function hideCard(el: Hideable): void {
  el.setAttribute("data-slop-hidden", "1");
  el.style.setProperty("display", "none", "important");
}

export function showCard(el: Hideable): void {
  el.removeAttribute("data-slop-hidden");
  el.style.removeProperty("display");
}

export interface Revealable extends Hideable {
  classList: { add(c: string): void; remove(c: string): void };
}

export const REVEAL_BATCH_MS = 120;
export const MAX_STAGGER = 7;

/** Проявляет карточку allowlist: маркер снимает CSS-шлюз, класс запускает анимацию (CSS). */
export function revealCard(el: Revealable, index: number): void {
  el.style.setProperty("--slop-i", String(Math.min(index, MAX_STAGGER)));
  el.classList.add("slop-reveal");
  el.setAttribute("data-slop-show", "1");
}

/** Возвращает карточку под управление шлюза (скрыта, если шлюз взведён). */
export function unrevealCard(el: Revealable): void {
  el.removeAttribute("data-slop-show");
  el.classList.remove("slop-reveal");
  el.style.removeProperty("--slop-i");
}

/**
 * Пачечное проявление: разрешённые карточки копятся и раскрываются не чаще раза за REVEAL_BATCH_MS
 * с нарастающим индексом анимации — сетка перестраивается порциями, а не на каждый ответ.
 */
export function createRevealer<E>(opts: { reveal(el: E, index: number): void; hide(el: E): void; delay?: number }): {
  allow(el: E): void;
  disallow(el: E): void;
} {
  const pending = new Set<E>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    timer = undefined;
    let i = 0;
    for (const el of pending) opts.reveal(el, Math.min(i++, MAX_STAGGER));
    pending.clear();
  };
  return {
    allow(el) {
      pending.add(el);
      timer ??= setTimeout(flush, opts.delay ?? REVEAL_BATCH_MS);
    },
    disallow(el) {
      pending.delete(el);
      opts.hide(el);
    },
  };
}
