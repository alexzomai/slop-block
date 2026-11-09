import type { DecideResponse, DecidedOk, PeekResponse, SmartTag, VideoMeta } from "../shared/decision";
import { tagIdentity as normText } from "../shared/settings";
import { createCache } from "./cache";
import { callJev } from "./client";
import { MAX_TAGS, buildRequest, parseResponse } from "./jev";
import { selectQuestions, subtopics } from "./subtopics";
import { createLimiter } from "./limiter";
import { createStats, statsStorage } from "./stats";
import { PROVIDERS, cacheNamespace, type ProviderId } from "./providers";
import { createRejections } from "./rejected";
import { activeModel, getKeyWithGen, getSettings } from "./settings";
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
  /** Общая память об отклонённых ключах (с запросом трат); иначе создаётся своя. */
  rejections?: ReturnType<typeof createRejections>;
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

/** Пакет peek: 1–MAX_PEEK видео и общий список тегов; иначе null. */
export const MAX_PEEK = 100;
function validatePeek(raw: unknown): { videos: VideoMeta[]; tags: SmartTag[] } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { videos?: unknown; tags?: unknown };
  if (!Array.isArray(r.videos) || r.videos.length === 0 || r.videos.length > MAX_PEEK) return null;
  const videos: VideoMeta[] = [];
  let tags: SmartTag[] | undefined;
  for (const v of r.videos) {
    const one = validate({ video: v, tags: r.tags });
    if (!one) return null;
    videos.push(one.video);
    tags = one.tags;
  }
  return { videos, tags: tags! };
}

export function createDecider(o: DeciderOptions) {
  const cache = createCache({ kv: o.kv, now: o.now });
  const limiter =
    o.limiter ??
    createLimiter({ ...(o.limits ?? { maxConcurrent: 6, perMinute: 60, maxQueue: 50 }), now: o.now, sleep: o.sleep });
  const statsOf = (p: ProviderId) => createStats({ kv: o.kv, now: o.now, storage: statsStorage(p) });
  const stats = { openrouter: statsOf("openrouter"), typesafe: statsOf("typesafe") };

  const rejections = o.rejections ?? createRejections(o.kv);
  type Err = "network" | "bad_response" | "no_key" | "rate_limited";
  type Fresh = { ok: true; probs: Map<string, number> } | { ok: false; error: Err };
  type Pair = { ok: true; p: number } | { ok: false; error: Err };
  // single-flight по каждой паре (videoId, текст тега): пару в полёте не заказывает никто, кроме владельца
  const inflight = new Map<string, Promise<Pair>>();
  const pairKey = (videoId: string, ns: string, n: string) => videoId + "|" + ns + "|" + n;

  async function fetchMissing(video: VideoMeta, missing: SmartTag[], key: string, keyGen: string, model: string, provider: ProviderId, ns: string): Promise<Fresh> {
    const body = buildRequest(model, video, missing);
    let res;
    try {
      res = await callJev({ fetch: o.fetch, key, url: PROVIDERS[provider].endpoint, body, sleep: o.sleep, random: o.random, schedule: limiter.run });
    } catch {
      return { ok: false, error: "network" };
    }
    if (!res.ok) {
      if (res.error !== "key_rejected") return { ok: false, error: res.error };
      // 401/403: запомнить отпечаток ключа; наружу — как «нет ключа» (контракт decision.ts не меняется)
      await rejections.mark(provider, key, keyGen).catch(() => undefined);
      return { ok: false, error: "no_key" };
    }
    // платный вызов учитывается здесь, в единственном месте его выполнения: один раз на запрос к Jev,
    // а не по числу ожидающих (single-flight) и не при попадании в кэш; запрос оплачен, даже если ответ не разобран
    await stats[provider].record(res.json);
    const parsed = parseResponse(res.json, missing);
    if (!parsed) return { ok: false, error: "bad_response" };
    const probs = new Map<string, number>();
    const pairs = missing.map((t) => ({ text: t.text, p: Math.round(parsed[t.id]! * 1000) / 1000 }));
    for (const x of pairs) probs.set(normText(x.text), x.p);
    await cache.set(video.videoId, pairs, ns);
    return { ok: true, probs };
  }

  /** Под-темы: единица вопроса, кэша и резерва в полёте; вероятность тега — максимум по его под-темам. */
  function plan(tags: SmartTag[]) {
    const used = tags.slice(0, MAX_TAGS);
    const subsOf = used.map((t) => subtopics(t.text));
    const asked: SmartTag[] = selectQuestions(subsOf, MAX_TAGS).map((text, i) => ({ id: `s${i}`, text }));
    const askedSet = new Set(asked.map((a) => normText(a.text)));
    return { used, subsOf, asked, askedSet };
  }
  type Plan = ReturnType<typeof plan>;

  /** Решение по известным вероятностям под-тем (общий код decide и peek). */
  function answer(p: Plan, known: Map<string, number>, threshold: number): DecidedOk {
    const probs: Record<string, number> = {};
    p.used.forEach((t, i) => {
      const ps = p.subsOf[i]!.map(normText).filter((n) => p.askedSet.has(n)).map((n) => known.get(n)!);
      probs[t.id] = ps.length > 0 ? Math.max(...ps) : 0;
    });
    const matchedTagIds = p.used.filter((t) => (probs[t.id] ?? 0) >= threshold).map((t) => t.id);
    return { ok: true, hide: matchedTagIds.length > 0, matchedTagIds, probabilities: probs };
  }

  /** Пакетная проверка кэша: без fetch, лимитера и учёта трат. Промахи в ответ не попадают. */
  async function peek(raw: unknown): Promise<PeekResponse> {
    const req = validatePeek(raw);
    if (!req) return { ok: false, error: "bad_response" };
    const settings = await getSettings(o.kv);
    const { key, gen: keyGen } = await getKeyWithGen(o.kv, settings.provider); // как в decide: ключ только активного провайдера
    if (!key || (await rejections.has(settings.provider, key, keyGen).catch(() => false))) return { ok: false, error: "no_key" };
    const ns = cacheNamespace(activeModel(settings)); // то же пространство кэша, что у decide
    const p = plan(req.tags);
    await cache.ready;
    const decisions: Record<string, DecidedOk> = {};
    for (const v of req.videos) {
      const cached = cache.peek(v.videoId, p.asked, ns);
      if (cached.some((c) => c === undefined)) continue;
      const known = new Map<string, number>();
      p.asked.forEach((t, i) => known.set(normText(t.text), cached[i]!));
      decisions[v.videoId] = answer(p, known, settings.threshold);
    }
    return { ok: true, decisions };
  }

  async function decide(raw: unknown): Promise<DecideResponse> {
    const req = validate(raw);
    if (!req) return BAD;
    const settings = await getSettings(o.kv);
    const { provider, threshold } = settings;
    const model = activeModel(settings);
    const { key, gen: keyGen } = await getKeyWithGen(o.kv, provider); // ключ только активного провайдера; ключ и поколение — один снимок
    if (!key || (await rejections.has(provider, key, keyGen).catch(() => false))) return { ok: false, error: "no_key" };
    const ns = cacheNamespace(model); // кэш делится по версии модели, не по провайдеру
    const p = plan(req.tags);
    const { asked } = p;

    // кэш по паре (videoId, текст тега): к Jev уходят только пары, которых нет ни в кэше, ни в чужом полёте.
    // Между проверкой кэша и резервом нет await — иначе чужой полёт успеет завершиться незамеченным.
    await cache.ready;
    const cached = cache.peek(req.video.videoId, asked, ns);
    const known = new Map<string, number>();
    asked.forEach((t, i) => cached[i] !== undefined && known.set(normText(t.text), cached[i]!));
    const waits: [string, Promise<Pair>][] = [];
    const mine: SmartTag[] = [];
    for (const t of asked) {
      const n = normText(t.text);
      if (known.has(n) || waits.some(([w]) => w === n) || mine.some((m) => normText(m.text) === n)) continue;
      const busy = inflight.get(pairKey(req.video.videoId, ns, n));
      if (busy) waits.push([n, busy]);
      else mine.push(t);
    }
    if (mine.length > 0) {
      const batch = fetchMissing(req.video, mine, key, keyGen, model, provider, ns);
      const keys = mine.map((t) => pairKey(req.video.videoId, ns, normText(t.text)));
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
    return answer(p, known, threshold);
  }

  return Object.assign(decide, { peek, rejections });
}
