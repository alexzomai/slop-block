import type { DecideResponse, SmartTag, VideoMeta } from "../shared/decision";
import { tagIdentity as normText } from "../shared/settings";
import { createCache } from "./cache";
import { callJev } from "./client";
import { MAX_TAGS, buildRequest, parseResponse } from "./jev";
import { selectQuestions, subtopics } from "./subtopics";
import { createLimiter } from "./limiter";
import { createStats } from "./stats";
import { getKey, getSettings } from "./settings";
import type { KV } from "./storage";

export interface DeciderOptions {
  kv: KV;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  /** Общий лимитер (с запросом трат); иначе создаётся свой. */
  limiter?: ReturnType<typeof createLimiter>;
  limits?: { maxConcurrent: number; perMinute: number; maxQueue: number };
}

const BAD: DecideResponse = { ok: false, error: "bad_response" };
const str = (v: unknown): v is string => typeof v === "string";

function validate(req: unknown) {
  if (typeof req !== "object" || req === null) return null;
  const r = req as { video?: Record<string, unknown>; tags?: unknown };
  const v = r.video;
  if (!v || !str(v.videoId) || !v.videoId || !str(v.title) || !str(v.channel)) return null;
  if (v.description !== undefined && !str(v.description)) return null;
  if (!Array.isArray(r.tags) || r.tags.length === 0) return null;
  for (const t of r.tags) if (!t || !str(t.id) || !str(t.text)) return null;
  return {
    video: { videoId: v.videoId, title: v.title, channel: v.channel, description: v.description as string | undefined },
    tags: r.tags as SmartTag[],
  };
}

export function createDecider(o: DeciderOptions) {
  const cache = createCache({ kv: o.kv, now: o.now });
  const limiter =
    o.limiter ??
    createLimiter({ ...(o.limits ?? { maxConcurrent: 4, perMinute: 60, maxQueue: 50 }), now: o.now, sleep: o.sleep });
  const stats = createStats({ kv: o.kv, now: o.now });

  type Fresh = { ok: true; probs: Map<string, number> } | { ok: false; error: "network" | "bad_response" | "no_key" | "rate_limited" };
  type Pair = { ok: true; p: number } | { ok: false; error: "network" | "bad_response" | "no_key" | "rate_limited" };
  // single-flight по каждой паре (videoId, текст тега): пару в полёте не заказывает никто, кроме владельца
  const inflight = new Map<string, Promise<Pair>>();
  const pairKey = (videoId: string, n: string) => videoId + "|" + n;

  async function fetchMissing(video: VideoMeta, missing: SmartTag[], key: string, model: string): Promise<Fresh> {
    const body = buildRequest(model, video, missing);
    let res;
    try {
      res = await callJev({ fetch: o.fetch, key, body, sleep: o.sleep, random: o.random, schedule: limiter.run });
    } catch {
      return { ok: false, error: "network" };
    }
    if (!res.ok) return { ok: false, error: res.error };
    // платный вызов учитывается здесь, в единственном месте его выполнения: один раз на запрос к Jev,
    // а не по числу ожидающих (single-flight) и не при попадании в кэш; запрос оплачен, даже если ответ не разобран
    await stats.record(res.json);
    const parsed = parseResponse(res.json, missing);
    if (!parsed) return { ok: false, error: "bad_response" };
    const probs = new Map<string, number>();
    const pairs = missing.map((t) => ({ text: t.text, p: Math.round(parsed[t.id]! * 1000) / 1000 }));
    for (const x of pairs) probs.set(normText(x.text), x.p);
    await cache.set(video.videoId, pairs);
    return { ok: true, probs };
  }

  return async function decide(raw: unknown): Promise<DecideResponse> {
    const req = validate(raw);
    if (!req) return BAD;
    const key = await getKey(o.kv);
    if (!key) return { ok: false, error: "no_key" };
    const { model, threshold } = await getSettings(o.kv);
    const used = req.tags.slice(0, MAX_TAGS);
    // под-темы: единица вопроса, кэша и резерва в полёте; вероятность тега — максимум по его под-темам
    const subsOf = used.map((t) => subtopics(t.text));
    const asked: SmartTag[] = selectQuestions(subsOf, MAX_TAGS).map((text, i) => ({ id: `s${i}`, text }));
    const askedSet = new Set(asked.map((a) => normText(a.text)));

    // кэш по паре (videoId, текст тега): к Jev уходят только пары, которых нет ни в кэше, ни в чужом полёте.
    // Между проверкой кэша и резервом нет await — иначе чужой полёт успеет завершиться незамеченным.
    await cache.ready;
    const cached = cache.peek(req.video.videoId, asked);
    const known = new Map<string, number>();
    asked.forEach((t, i) => cached[i] !== undefined && known.set(normText(t.text), cached[i]!));
    const waits: [string, Promise<Pair>][] = [];
    const mine: SmartTag[] = [];
    for (const t of asked) {
      const n = normText(t.text);
      if (known.has(n) || waits.some(([w]) => w === n) || mine.some((m) => normText(m.text) === n)) continue;
      const busy = inflight.get(pairKey(req.video.videoId, n));
      if (busy) waits.push([n, busy]);
      else mine.push(t);
    }
    if (mine.length > 0) {
      const batch = fetchMissing(req.video, mine, key, model);
      const keys = mine.map((t) => pairKey(req.video.videoId, normText(t.text)));
      mine.forEach((t, i) => {
        const n = normText(t.text);
        const pr: Promise<Pair> = batch.then((f) => (f.ok ? { ok: true, p: f.probs.get(n)! } : f));
        inflight.set(keys[i]!, pr);
        waits.push([n, pr]);
      });
      const release = () => keys.forEach((k) => inflight.delete(k));
      void batch.then(release, release);
    }
    const results = await Promise.all(waits.map(([, pr]) => pr));
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (!r.ok) return r;
      known.set(waits[i]![0], r.p);
    }
    const probs: Record<string, number> = {};
    used.forEach((t, i) => {
      const ps = subsOf[i]!.map(normText).filter((n) => askedSet.has(n)).map((n) => known.get(n)!);
      probs[t.id] = ps.length > 0 ? Math.max(...ps) : 0;
    });
    const matchedTagIds = used.filter((t) => (probs[t.id] ?? 0) >= threshold).map((t) => t.id);
    return { ok: true, hide: matchedTagIds.length > 0, matchedTagIds, probabilities: probs };
  };
}
