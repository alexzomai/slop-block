// Единственное место, знающее путь страницы подписок YouTube.
const SUBSCRIPTIONS = /^\/feed\/subscriptions\/?$/;

/** `pathname` страницы подписок (без query/hash). Нестроки и прочие пути → false. */
export function isSubscriptionsPath(pathname: unknown): boolean {
  return typeof pathname === "string" && SUBSCRIPTIONS.test(pathname);
}
