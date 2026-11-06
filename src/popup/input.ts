export interface KeyLike { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing: boolean }

/** Enter добавляет тег; Shift+Enter (перенос), Enter в IME-композиции и с модификаторами — нет. */
export function isSubmitKey(e: KeyLike): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing;
}

/** Счётчик «n/max»: n — длина текста после схлопывания пробельных серий; на пределе — подсветка. */
export function counterView(value: string, max: number): { n: number; atLimit: boolean } {
  const n = Math.min(value.replace(/\s+/g, " ").length, max);
  return { n, atLimit: n >= max };
}

/** Высота авто-растущего поля: по содержимому, но не выше потолка (дальше — внутренняя прокрутка). */
export const clampHeight = (scrollHeight: number, maxHeight: number): number => Math.min(scrollHeight, maxHeight);
