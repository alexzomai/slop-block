import { tagIdentity } from "../shared/settings";
import type { KV } from "./storage";

/** Кэш вероятностей по паре (videoId, нормализованный текст тега). Формат и расчёт размера — design.md, D1–D5. */
export const SHARD_PREFIX = "dc2:";
export const LEGACY_KEY = "decisionCache";
export const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;
export const DEFAULT_MAX_PAIRS = 20000;
const SHARDS = 256;
const EVICT_TO = 0.9;
const MINUTE = 60_000;

/** trim, схлопывание пробелов, нижний регистр — то же, что идентичность тега (shared/settings). Формат ключей кэша не менялся. */
export const normText = tagIdentity;

/** FNV-1a 64 бит → base36. Не криптографический: коллизия лишь подменяет значение в собственном кэше. */
function tagKey(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(normText(text))) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(36);
}

function shardOf(videoId: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(videoId)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return SHARD_PREFIX + (h & (SHARDS - 1)).toString(16).padStart(2, "0");
}
const ALL_SHARDS = Array.from({ length: SHARDS }, (_, i) => SHARD_PREFIX + i.toString(16).padStart(2, "0"));

/** [время последней записи в минутах, {ключ тега: вероятность в тысячных}] */
type VideoRec = [number, Record<string, number>];
type Shard = Record<string, VideoRec>;

export interface CacheOptions { kv: KV; now: () => number; ttlMs?: number; maxPairs?: number }
export interface PairIn { text: string; p: number }

export function createCache(o: CacheOptions) {
  const ttl = o.ttlMs ?? DEFAULT_TTL_MS;
  const max = o.maxPairs ?? DEFAULT_MAX_PAIRS;
  const shards = new Map<string, Shard>();
  const dirty = new Set<string>();
  let pairs = 0;
  let flushing: Promise<void> | undefined;
  let writeChain: Promise<unknown> = Promise.resolve();

  const expired = (rec: VideoRec) => o.now() - rec[0] * MINUTE > ttl;
  const count = (rec: VideoRec) => Object.keys(rec[1]).length;

  const ready = (async () => {
    try {
      await o.kv.remove(LEGACY_KEY); // миграция: старый кэш не переносится
      const got = await o.kv.get(ALL_SHARDS);
      for (const k of ALL_SHARDS) {
        const raw = got[k];
        const s: Shard = typeof raw === "object" && raw !== null ? (raw as Shard) : {};
        for (const [v, rec] of Object.entries(s)) {
          if (!Array.isArray(rec) || typeof rec[0] !== "number" || typeof rec[1] !== "object" || rec[1] === null || expired(rec)) {
            delete s[v];
            dirty.add(k);
          } else pairs += count(rec);
        }
        shards.set(k, s);
      }
    } catch {
      for (const k of ALL_SHARDS) if (!shards.has(k)) shards.set(k, {});
    }
  })();

  function evict(): void {
    if (pairs <= max) return;
    const all: { k: string; v: string; t: number }[] = [];
    for (const [k, s] of shards) for (const [v, rec] of Object.entries(s)) all.push({ k, v, t: rec[0] });
    all.sort((a, b) => a.t - b.t);
    const target = Math.floor(max * EVICT_TO);
    for (const e of all) {
      if (pairs <= target) break;
      const s = shards.get(e.k)!;
      pairs -= count(s[e.v]!);
      delete s[e.v];
      dirty.add(e.k);
    }
  }

  function flush(): Promise<void> {
    flushing ??= Promise.resolve().then(() => {
      flushing = undefined;
      const batch = [...dirty];
      if (batch.length === 0) return;
      const items: Record<string, unknown> = {};
      for (const k of batch) items[k] = shards.get(k) ?? {};
      const job = writeChain.then(() => o.kv.set(items)).then(
        () => { for (const k of batch) dirty.delete(k); },
        () => undefined, // квота/сбой: запись пропущена, следующая попытка повторит грязные шарды
      );
      writeChain = job;
      return job;
    });
    return flushing;
  }

  function peek(videoId: string, tags: { text: string }[]): (number | undefined)[] {
    const rec = shards.get(shardOf(videoId))?.[videoId];
    if (!rec || expired(rec)) return tags.map(() => undefined);
    return tags.map((t) => {
      const v = rec[1][tagKey(t.text)];
      return typeof v === "number" ? v / 1000 : undefined;
    });
  }

  return {
    ready,
    /** Вероятности для тегов в порядке входа; undefined — пары нет или она просрочена. */
    async get(videoId: string, tags: { text: string }[]): Promise<(number | undefined)[]> {
      await ready;
      return peek(videoId, tags);
    },
    /** То же без ожидания: валидно только после `await ready` (нужно, чтобы проверка кэша и резерв в полёте шли без await между ними). */
    peek,
    /** Добавляет пары к видео (обновляет время записи видео). Параллельные set одного хода делят один kv.set. */
    async set(videoId: string, add: PairIn[]): Promise<void> {
      await ready;
      const sk = shardOf(videoId);
      const s = shards.get(sk)!;
      let rec = s[videoId];
      if (!rec || expired(rec)) {
        if (rec) pairs -= count(rec);
        rec = [0, {}];
        s[videoId] = rec;
      }
      rec[0] = Math.ceil(o.now() / MINUTE); // округление вверх: запись живёт не меньше TTL
      for (const a of add) {
        const k = tagKey(a.text);
        if (!(k in rec[1])) pairs++;
        rec[1][k] = Math.round(Math.min(1, Math.max(0, a.p)) * 1000);
      }
      dirty.add(sk);
      evict();
      return flush();
    },
  };
}
