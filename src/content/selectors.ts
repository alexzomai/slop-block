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
