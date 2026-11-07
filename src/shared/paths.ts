// Единственное место, знающее путь страницы подписок YouTube.
const SUBSCRIPTIONS = /^\/feed\/subscriptions\/?$/;

/** `pathname` страницы подписок (без query/hash). Нестроки и прочие пути → false. */
export function isSubscriptionsPath(pathname: unknown): boolean {
  return typeof pathname === "string" && SUBSCRIPTIONS.test(pathname);
}

const SEARCH = /^\/results\/?$/;

/** `pathname` страницы результатов поиска (без query/hash). `/hashtag/…` сюда не входит. */
export function isSearchPath(pathname: unknown): boolean {
  return typeof pathname === "string" && SEARCH.test(pathname);
}
