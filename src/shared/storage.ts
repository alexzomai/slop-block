import { MAX_TAGS, STORAGE_KEY, normalize, type Settings } from "./settings";

// Формат в chrome.storage.sync (укладывается в квоты при любом допустимом вводе):
//   "slop.settings"       = { enabled: boolean, order: string[] }   — маленький item
//   "slop.tag.<id>"       = { text: string, enabled: boolean }      — по одному item на тег
// Худший случай: 20 тегов × 200 UTF-16 единиц, каждая экранируется JSON как \u00XX (6 байт) → ≈1,3 КБ на тег,
// ≈26 КБ всего, 21 item — далеко от QUOTA_BYTES_PER_ITEM (8192), QUOTA_BYTES (102400), MAX_ITEMS (512).
export const TAG_KEY_PREFIX = "slop.tag.";
export const tagKey = (id: string): string => TAG_KEY_PREFIX + id;

export interface AreaLike {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}
export interface ChangeEmitter {
  addListener(cb: (changes: Record<string, unknown>, area: string) => void): void;
}

/** Представление настроек в виде набора item'ов storage. */
export function toItems(s: Settings): Record<string, unknown> {
  const items: Record<string, unknown> = {
    [STORAGE_KEY]: { enabled: s.enabled, order: s.tags.map((t) => t.id), mode: s.mode, skipSubscriptions: s.skipSubscriptions, feedTarget: s.feedTarget },
  };
  for (const t of s.tags) items[tagKey(t.id)] = { text: t.text, enabled: t.enabled };
  return items;
}

export function fromItems(items: Record<string, unknown>): Settings {
  const head = items[STORAGE_KEY];
  if (typeof head !== "object" || head === null) return normalize(undefined);
  const h = head as Record<string, unknown>;
  const order = Array.isArray(h.order) ? h.order.slice(0, MAX_TAGS) : [];
  const tags = order.map((id) => {
    const t = typeof id === "string" ? items[tagKey(id)] : undefined;
    return typeof t === "object" && t !== null ? { id, ...(t as object) } : null;
  });
  return normalize({ enabled: h.enabled, tags, mode: h.mode, skipSubscriptions: h.skipSubscriptions, feedTarget: h.feedTarget });
}

export async function loadSettings(area: AreaLike): Promise<Settings> {
  const head = await area.get(STORAGE_KEY);
  const h = head[STORAGE_KEY] as { order?: unknown } | undefined;
  const ids = Array.isArray(h?.order) ? h.order.filter((x): x is string => typeof x === "string").slice(0, MAX_TAGS) : [];
  const tags = ids.length > 0 ? await area.get(ids.map(tagKey)) : {};
  return fromItems({ ...head, ...tags });
}

/** Записывает настройки одним set() и удаляет осиротевшие теги. Бросает исключение при отказе записи. */
export async function saveSettings(area: AreaLike, s: Settings): Promise<void> {
  const items = toItems(s);
  await area.set(items);
  const stale = Object.keys(await area.get(null)).filter((k) => k.startsWith(TAG_KEY_PREFIX) && !(k in items));
  if (stale.length > 0) await area.remove(stale);
}

/** Подписка: любое изменение наших ключей в sync → cb() (вызывающий перечитывает настройки). */
export function subscribeSettings(emitter: ChangeEmitter, cb: () => void): void {
  emitter.addListener((changes, area) => {
    if (area === "sync" && Object.keys(changes).some((k) => k === STORAGE_KEY || k.startsWith(TAG_KEY_PREFIX))) cb();
  });
}
