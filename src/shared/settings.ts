import type { SmartTag } from "./decision";

export interface StoredTag { id: string; text: string; enabled: boolean }
/** allowlist — показывать только подходящие; blocklist — скрывать подходящие. */
export type Mode = "allowlist" | "blocklist";
export interface Settings { enabled: boolean; tags: StoredTag[]; mode: Mode; skipSubscriptions: boolean; feedTarget: number }
export type AddError = "empty" | "too_long" | "limit" | "duplicate";

export const MAX_TAGS = 20;
export const MAX_TEXT = 200;
export const STORAGE_KEY = "slop.settings";
/** id попадает в имя ключа storage — только безопасные символы и ограниченная длина. */
export const ID_RE = /^[\w-]{1,64}$/;
export const MIN_TARGET = 6;
export const MAX_TARGET = 30;
export const DEFAULT_TARGET = 12;
export const DEFAULT_SETTINGS: Settings = { enabled: true, tags: [], mode: "allowlist", skipSubscriptions: true, feedTarget: DEFAULT_TARGET };

/** Цель ленты: целое 6–30. Не число / NaN / Infinity / нечисловая строка → 12. */
export function clampTarget(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_TARGET;
  return Math.min(MAX_TARGET, Math.max(MIN_TARGET, Math.round(v)));
}

/** Приводит произвольное значение из хранилища к валидным настройкам. Отсутствующие mode/skip = миграция по умолчанию. */
export function normalize(raw: unknown): Settings {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_SETTINGS, tags: [] };
  const r = raw as Record<string, unknown>;
  const enabled = typeof r.enabled === "boolean" ? r.enabled : true;
  const mode: Mode = r.mode === "blocklist" ? "blocklist" : "allowlist";
  const skipSubscriptions = typeof r.skipSubscriptions === "boolean" ? r.skipSubscriptions : true;
  const tags: StoredTag[] = [];
  const ids = new Set<string>();
  if (Array.isArray(r.tags)) {
    for (const t of r.tags) {
      if (tags.length >= MAX_TAGS) break;
      if (typeof t !== "object" || t === null) continue;
      const o = t as Record<string, unknown>;
      if (typeof o.id !== "string" || !ID_RE.test(o.id) || typeof o.text !== "string" || ids.has(o.id)) continue;
      const text = o.text.trim().slice(0, MAX_TEXT);
      if (text === "") continue;
      ids.add(o.id);
      tags.push({ id: o.id, text, enabled: typeof o.enabled === "boolean" ? o.enabled : true });
    }
  }
  return { enabled, tags, mode, skipSubscriptions, feedTarget: clampTarget(r.feedTarget) };
}

/** Тег — одна строка: переносы и серии пробельных символов схлопываются в один пробел. */
export const normalizeTagText = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Каноническая идентичность тега — ЕДИНСТВЕННОЕ определение «те же теги» в проекте (дубликаты, ключ кэша решений).
 * Применяется с обеих сторон любого сравнения: тексты, сохранённые прежними версиями (с внутренними сериями пробелов), равны новым.
 */
export const tagIdentity = (text: string): string => normalizeTagText(text).toLowerCase();

export function addTag(
  s: Settings,
  text: string,
  newId: () => string = () => crypto.randomUUID(),
): { settings: Settings; error?: AddError } {
  const t = normalizeTagText(text);
  if (t === "") return { settings: s, error: "empty" };
  if (t.length > MAX_TEXT) return { settings: s, error: "too_long" };
  if (s.tags.length >= MAX_TAGS) return { settings: s, error: "limit" };
  const id = tagIdentity(t);
  if (s.tags.some((x) => tagIdentity(x.text) === id)) return { settings: s, error: "duplicate" };
  return { settings: { ...s, tags: [...s.tags, { id: newId(), text: t, enabled: true }] } };
}

export const removeTag = (s: Settings, id: string): Settings => ({ ...s, tags: s.tags.filter((t) => t.id !== id) });
export const toggleTag = (s: Settings, id: string): Settings => ({
  ...s,
  tags: s.tags.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t)),
});
export const setEnabled = (s: Settings, enabled: boolean): Settings => ({ ...s, enabled });

/** Теги для запроса: только включённые и только поля контракта. Пусто, если фильтр выключен. */
export function activeTags(s: Settings): SmartTag[] {
  return s.enabled ? s.tags.filter((t) => t.enabled).map((t) => ({ id: t.id, text: t.text })) : [];
}

export const setMode = (s: Settings, mode: Mode): Settings => ({ ...s, mode });
export const setFeedTarget = (s: Settings, v: number): Settings => ({ ...s, feedTarget: clampTarget(v) });
export const setSkipSubscriptions = (s: Settings, skipSubscriptions: boolean): Settings => ({ ...s, skipSubscriptions });

export interface FilterContext { onSubscriptions: boolean; keyMissing: boolean }

/** Единая точка решения «работает ли фильтр сейчас» и с какими тегами. */
export function effectiveState(s: Settings, ctx: FilterContext): { active: boolean; mode: Mode; tags: SmartTag[] } {
  const bypass = s.skipSubscriptions && ctx.onSubscriptions;
  const tags = bypass ? [] : activeTags(s);
  return { active: tags.length > 0 && !ctx.keyMissing, mode: s.mode, tags };
}
