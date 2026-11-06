export interface Markable {
  setAttribute(name: string, value: string): void;
}

/** Помечает, что content script загрузился. Больше ничего на странице не трогает. */
export function markLoaded(root: Markable): void {
  root.setAttribute("data-slop-block", "loaded");
}
