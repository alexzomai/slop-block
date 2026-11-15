// Единственное место, знающее про вёрстку YouTube. При смене разметки правится только этот файл.
// Деградация безопасна: если селекторы не находят карточки, ничего не скрывается.

export interface ElLike {
  querySelector(sel: string): ElLike | null;
  textContent: string | null;
  getAttribute(name: string): string | null;
}
export interface VideoMetaLike { videoId: string; title: string; channel: string; description?: string }

/** Контейнеры карточек: главная, поиск, рекомендации, сетка, новая lockup-вёрстка, полки шортсов. */
export const CARD_SELECTOR = [
  "ytd-rich-item-renderer",
  "ytd-video-renderer",
  "ytd-compact-video-renderer",
  "ytd-grid-video-renderer",
  "yt-lockup-view-model",
  "ytm-shorts-lockup-view-model",
  "ytd-reel-item-renderer",
].join(", ");

const WATCH_LINK = 'a[href*="/watch?v="]';
const SHORTS_LINK = 'a[href*="/shorts/"]';
const TITLE = "#video-title, a#video-title-link, .yt-lockup-metadata-view-model__title, h3";
const CHANNEL = "ytd-channel-name a, #channel-name a, .yt-content-metadata-view-model__metadata-text";
const DESCRIPTION = "#description-text, .metadata-snippet-text";

const ID_RE = /^[\w-]{6,20}$/;
const MAX_TITLE = 300;
const MAX_CHANNEL = 200;
const MAX_DESC = 500;

export function findCards(root: { querySelectorAll(sel: string): Iterable<Element> }): Element[] {
  return [...root.querySelectorAll(CARD_SELECTOR)];
}

/** Страница SPA, которой принадлежит карточка (YouTube держит прежние страницы в DOM скрытыми); null — не нашли (общая область). */
export function pageScope(card: { closest?(sel: string): unknown }): unknown {
  try {
    return card.closest?.("ytd-page-manager > *") ?? null;
  } catch {
    return null;
  }
}

function idFromHref(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, "https://www.youtube.com");
  } catch {
    return null;
  }
  const id = url.pathname.startsWith("/shorts/") ? url.pathname.slice("/shorts/".length).split("/")[0] : url.searchParams.get("v");
  return id && ID_RE.test(id) ? id : null;
}

const clean = (s: string | null | undefined, max: number): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Читает метаданные карточки. Только textContent и атрибуты, без разбора разметки. */
export function extractMeta(card: ElLike): VideoMetaLike | null {
  const a = card.querySelector(WATCH_LINK) ?? card.querySelector(SHORTS_LINK);
  const href = a?.getAttribute("href");
  if (!a || !href) return null;
  const videoId = idFromHref(href);
  if (!videoId) return null;
  const title = clean(card.querySelector(TITLE)?.textContent ?? a.getAttribute("aria-label") ?? a.getAttribute("title"), MAX_TITLE);
  if (title === "") return null;
  const channel = clean(card.querySelector(CHANNEL)?.textContent, MAX_CHANNEL);
  const description = clean(card.querySelector(DESCRIPTION)?.textContent, MAX_DESC);
  return description ? { videoId, title, channel, description } : { videoId, title, channel };
}

/**
 * Рекламные слоты. Признак — любой из независимых (не только текст на одном языке); сомнение = обычная карточка (fail-open).
 *  1) теги/классы рекламных рендереров внутри карточки (in-feed ad, display/promoted ad, ad slot);
 *  2) значок рекламы: отдельный элемент-бейдж, текст которого целиком равен «Sponsored» на одном из языков, либо тег ad-badge;
 *  3) ссылка карточки ведёт на рекламный редирект: hostname googleadservices.com / doubleclick.net / googlesyndication.com (и поддомены) либо youtube.com/pagead/…, /aclk; домен в path, handle или query не считается.
 */
export const AD_RENDERER_SELECTOR = [
  "ytd-ad-slot-renderer",
  "ytd-in-feed-ad-layout-renderer",
  "ytd-display-ad-renderer",
  "ytd-promoted-sparkles-web-renderer",
  "ytd-promoted-video-renderer",
  "ytd-compact-promoted-video-renderer",
  "ytd-search-pyv-renderer",
  "ytd-banner-promo-renderer",
  "ytd-statement-banner-renderer",
  "ad-slot-renderer",
  "ad-badge-view-model",
  "ytd-ad-badge-renderer",
  '[class*="ytd-ad-slot"]',
  '[class*="in-feed-ad"]',
].join(", ");
const AD_BADGE_SELECTOR = "badge-shape, ytd-badge-supported-renderer, .yt-badge-shape__text, .badge-style-type-ad, [class*='ad-badge']";
const LINK_SELECTOR = "a[href]";
/** Домены рекламных редиректов: сам домен и любой поддомен (hostname, не подстрока href). */
const AD_HOSTS = ["googleadservices.com", "doubleclick.net", "googlesyndication.com"];
const hostIs = (host: string, domain: string): boolean => host === domain || host.endsWith("." + domain);

/** Рекламный ли редирект: по hostname (YouTube-ссылки с доменом в path/query/handle не в счёт) и пути /pagead/ на youtube.com. */
export function isAdHref(href: string | null): boolean {
  if (!href) return false;
  let url: URL;
  try {
    url = new URL(href, "https://www.youtube.com");
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (AD_HOSTS.some((d) => hostIs(host, d))) return true;
  return hostIs(host, "youtube.com") && (url.pathname.startsWith("/pagead/") || url.pathname === "/aclk");
}
const AD_BADGE_TEXT = /^(sponsored|ad|ads|advertisement|реклама|anzeige|publicidad|anuncio|annonce|publicité|pubblicità|annuncio|anúncio|patrocinado|reklam|reklama|広告|광고|广告|廣告|إعلان)$/i;

export interface AdLike extends ElLike {
  matches?(sel: string): boolean;
  querySelectorAll?(sel: string): Iterable<ElLike>;
}

/** Рекламная ли карточка. Любое исключение/неясность → false. */
export function isAdSlot(card: AdLike): boolean {
  try {
    if (card.matches?.(AD_RENDERER_SELECTOR)) return true;
    if (card.querySelector(AD_RENDERER_SELECTOR)) return true;
    if (card.querySelectorAll) {
      for (const a of card.querySelectorAll(LINK_SELECTOR)) if (isAdHref(a.getAttribute("href"))) return true;
      for (const b of card.querySelectorAll(AD_BADGE_SELECTOR)) if (AD_BADGE_TEXT.test(clean(b.textContent, 40))) return true;
    }
  } catch {
    /* fail-open */
  }
  return false;
}
