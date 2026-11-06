import { describe, expect, it, vi } from "vitest";
import { createDecider } from "../src/background/decide";
import type { DecideRequest } from "../src/shared/decision";
import { SECRET, fakeKV, okBody, resp } from "./helpers/fake";

const req: DecideRequest = {
  type: "slop/decide",
  video: { videoId: "v1", title: "T", channel: "C" },
  tags: [{ id: "a", text: "кликбейт" }, { id: "b", text: "политика" }],
};
function setup(fetchImpl: any, kvInit: Record<string, unknown> = { openrouterKey: SECRET }) {
  const kv = fakeKV(kvInit);
  const decide = createDecider({ kv, fetch: fetchImpl, now: () => 1000, sleep: async () => {}, random: () => 0 });
  return { kv, decide };
}

describe("decide", () => {
  it("success: hide when prob >= threshold (inclusive), probabilities for every tag", async () => {
    const f = vi.fn(async () => resp(200, okBody({ t0: 0.7, t1: 0.2 })));
    const { decide } = setup(f);
    expect(await decide(req)).toEqual({ ok: true, hide: true, matchedTagIds: ["a"], probabilities: { a: 0.7, b: 0.2 } });
  });
  it("below threshold -> show", async () => {
    const { decide } = setup(vi.fn(async () => resp(200, okBody({ t0: 0.69, t1: 0.2 }))));
    expect(await decide(req)).toEqual({ ok: true, hide: false, matchedTagIds: [], probabilities: { a: 0.69, b: 0.2 } });
  });
  it("no key -> no_key without fetch", async () => {
    const f = vi.fn();
    const { decide } = setup(f, {});
    expect(await decide(req)).toEqual({ ok: false, error: "no_key" });
    expect(f).not.toHaveBeenCalled();
  });
  it.each([
    ["no tags", { ...req, tags: [] }],
    ["bad videoId", { ...req, video: { ...req.video, videoId: 5 } }],
    ["bad tag", { ...req, tags: [{ id: 1, text: "x" }] }],
    ["null", null],
  ])("invalid request (%s) -> bad_response without fetch", async (_n, r) => {
    const f = vi.fn();
    const { decide } = setup(f);
    expect(await decide(r)).toEqual({ ok: false, error: "bad_response" });
    expect(f).not.toHaveBeenCalled();
  });
  it("caches; second call has no fetch; threshold change applies to cached", async () => {
    const f = vi.fn(async () => resp(200, okBody({ t0: 0.5, t1: 0.1 })));
    const { decide, kv } = setup(f);
    expect((await decide(req) as any).hide).toBe(false);
    await kv.set({ settings: { model: "typesafe/jev-1.13", threshold: 0.4 } });
    expect((await decide(req) as any).hide).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("incomplete answers -> bad_response, not cached", async () => {
    const f = vi.fn(async () => resp(200, okBody({ t0: 0.9 })));
    const { decide } = setup(f);
    expect(await decide(req)).toEqual({ ok: false, error: "bad_response" });
    await decide(req);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("failures never hide and never leak key", async () => {
    for (const s of [429, 503, 401, 400]) {
      const { decide } = setup(vi.fn(async () => resp(s, { error: { message: SECRET } })));
      const r = await decide(req);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
  });
  it("queue overflow -> rate_limited", async () => {
    const kv = fakeKV({ openrouterKey: SECRET });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = vi.fn(async () => { await gate; return resp(200, okBody({ t0: 0, t1: 0 })); });
    const decide = createDecider({ kv, fetch: f as any, now: () => 1, sleep: async () => {}, random: () => 0, limits: { maxConcurrent: 1, perMinute: 100, maxQueue: 1 } });
    const mk = (i: number) => ({ ...req, video: { ...req.video, videoId: `x${i}` } });
    const p = [decide(mk(0)), decide(mk(1))];
    await new Promise((r) => setTimeout(r, 20));
    expect(await decide(mk(2))).toEqual({ ok: false, error: "rate_limited" });
    release();
    await Promise.all(p);
  });
});

describe("decide: кэш по паре и single-flight", () => {
  const answerFor = (map: Record<string, number>) =>
    vi.fn(async (_u: unknown, init: any) => {
      const q = JSON.parse(init.body).questions as Record<string, { instructions: string }>;
      const ans = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, (Object.entries(map).find(([text]) => v.instructions.toLowerCase().includes(`«${text}»`)) ?? ["", 0.05])[1]]));
      return resp(200, okBody(ans));
    });
  const questionsOf = (f: any, i: number) => Object.keys(JSON.parse(f.mock.calls[i][1].body).questions);
  const withTags = (...texts: string[]): DecideRequest => ({ ...req, tags: texts.map((t, i) => ({ id: `id${i}-${t}`, text: t })) });

  it("(а) повтор того же видео с теми же тегами — 0 fetch", async () => {
    const f = answerFor({ кликбейт: 0.9 });
    const { decide } = setup(f);
    await decide(req);
    const r = await decide(req);
    expect(f).toHaveBeenCalledTimes(1);
    expect((r as any).ok).toBe(true);
  });
  it("(б) добавили тег — 1 fetch ровно с 1 вопросом, hide по объединению; выкл/вкл — 0 fetch", async () => {
    const f = answerFor({ кликбейт: 0.1, политика: 0.1, новый: 0.95 });
    const { decide } = setup(f);
    await decide(withTags("кликбейт", "политика"));
    expect(f).toHaveBeenCalledTimes(1);
    const r: any = await decide(withTags("кликбейт", "политика", "новый"));
    expect(f).toHaveBeenCalledTimes(2);
    expect(questionsOf(f, 1)).toEqual(["t0"]);
    const body = JSON.parse((f.mock.calls[1] as any)[1].body);
    expect(body.questions.t0.instructions).toContain("новый");
    expect(body.state.title).toBe("T");
    expect(r.hide).toBe(true);
    expect(r.matchedTagIds).toEqual(["id2-новый"]);
    expect(Object.keys(r.probabilities)).toHaveLength(3);
    await decide(withTags("кликбейт")); // выключили два тега
    await decide(withTags("кликбейт", "политика", "новый")); // включили
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("переименование туда-обратно: известный текст не запрашивается заново", async () => {
    const f = answerFor({});
    const { decide } = setup(f);
    await decide(withTags("кликбейт"));
    await decide(withTags("клик"));
    expect(f).toHaveBeenCalledTimes(2);
    await decide(withTags("  КЛИКБЕЙТ "));
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("два тега с одним текстом — один вопрос, обе id получают вероятность", async () => {
    const f = answerFor({ дубль: 0.8 });
    const { decide } = setup(f);
    const r: any = await decide({ ...req, tags: [{ id: "a", text: "Дубль" }, { id: "b", text: "дубль" }] });
    expect(questionsOf(f, 0)).toEqual(["t0"]);
    expect(r.matchedTagIds).toEqual(["a", "b"]);
  });
  it("(в) N параллельных decide одного videoId — 1 fetch, одинаковое решение", async () => {
    const f = answerFor({ кликбейт: 0.9 });
    const { decide } = setup(f);
    const rs = await Promise.all(Array.from({ length: 8 }, () => decide(withTags("кликбейт", "политика"))));
    expect(f).toHaveBeenCalledTimes(1);
    for (const r of rs) expect(r).toEqual(rs[0]);
    expect((rs[0] as any).hide).toBe(true);
  });
  it("ошибка общего полёта раздаётся всем, не кэшируется; следующий вызов повторяет", async () => {
    let fail = true;
    const f = vi.fn(async (_u: unknown, init: any) => {
      if (fail) return resp(400, {});
      const q = JSON.parse(init.body).questions;
      return resp(200, okBody(Object.fromEntries(Object.keys(q).map((k) => [k, 0.1]))));
    });
    const { decide } = setup(f);
    const rs = await Promise.all([decide(req), decide(req), decide(req)]);
    expect(f).toHaveBeenCalledTimes(1);
    for (const r of rs) expect(r).toEqual({ ok: false, error: "bad_response" });
    fail = false;
    expect((await decide(req) as any).ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("разные видео параллельно не склеиваются", async () => {
    const f = answerFor({});
    const { decide } = setup(f);
    await Promise.all([decide(req), decide({ ...req, video: { ...req.video, videoId: "v2" } })]);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("перезапуск SW (новый decider на том же kv) — 0 fetch", async () => {
    const f = answerFor({});
    const kv = fakeKV({ openrouterKey: SECRET });
    const mkd = () => createDecider({ kv, fetch: f as any, now: () => 1000, sleep: async () => {}, random: () => 0 });
    await mkd()(req);
    await mkd()(req);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("decide: резерв в полёте по каждой паре (r1)", () => {
  const vreq = (texts: string[], videoId = "v1"): DecideRequest => ({
    type: "slop/decide", video: { videoId, title: "T", channel: "C" }, tags: texts.map((t) => ({ id: t, text: t })),
  });
  /** fetch с воротами и подсчётом вопросов по (videoId из title, текст). */
  function gated(opts: { fail?: (texts: string[]) => boolean } = {}) {
    const paid = new Map<string, number>();
    const waiters: (() => void)[] = [];
    let open = false;
    const f = vi.fn(async (_u: unknown, init: any) => {
      const body = JSON.parse(init.body);
      const texts = Object.values(body.questions).map((q: any) => /«(.*)»/.exec(q.instructions)![1]!);
      for (const t of texts) paid.set(`${body.state.title}|${t}`, (paid.get(`${body.state.title}|${t}`) ?? 0) + 1);
      if (!open) await new Promise<void>((r) => waiters.push(r));
      if (opts.fail?.(texts)) return resp(400, {});
      return resp(200, okBody(Object.fromEntries(Object.keys(body.questions).map((k) => [k, 0.9]))));
    });
    return { f, paid, release: () => { open = true; waiters.splice(0).forEach((r) => r()); } };
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("[A] в полёте, затем [A,B]: A платится один раз, B — отдельным вопросом", async () => {
    const g = gated();
    const { decide } = setup(g.f);
    const p1 = decide(vreq(["a"]));
    await tick();
    const p2 = decide(vreq(["a", "b"]));
    await tick();
    g.release();
    const [r1, r2] = (await Promise.all([p1, p2])) as any[];
    expect(r1.ok && r2.ok).toBe(true);
    expect(r2.probabilities).toEqual({ a: 0.9, b: 0.9 });
    expect(g.paid.get("T|a")).toBe(1);
    expect(g.paid.get("T|b")).toBe(1);
    expect(g.f).toHaveBeenCalledTimes(2);
  });
  it("[A,B] ∥ [B,C]: B платится один раз", async () => {
    const g = gated();
    const { decide } = setup(g.f);
    const p = [decide(vreq(["a", "b"])), decide(vreq(["b", "c"]))];
    await tick();
    g.release();
    const rs = (await Promise.all(p)) as any[];
    expect(rs.every((r) => r.ok)).toBe(true);
    for (const t of ["a", "b", "c"]) expect(g.paid.get(`T|${t}`)).toBe(1);
  });
  it("ошибка полёта: ожидающие получают ту же ошибку, пары освобождены, в кэш ничего; следующий вызов перезапрашивает", async () => {
    let failing = true;
    const g = gated({ fail: () => failing });
    const { decide } = setup(g.f);
    const p = [decide(vreq(["a"])), decide(vreq(["a", "b"])), decide(vreq(["a"]))];
    await tick();
    g.release();
    const rs = (await Promise.all(p)) as any[];
    expect(rs[0]).toEqual({ ok: false, error: "bad_response" });
    expect(rs[2]).toEqual({ ok: false, error: "bad_response" });
    expect(rs[1].ok).toBe(false); // ждал занятую A -> та же ошибка (B ушёл отдельным запросом и тоже упал)
    failing = false;
    const again: any = await decide(vreq(["a", "b"]));
    expect(again.ok).toBe(true);
    expect(g.paid.get("T|a")).toBe(2); // первый полёт (ошибка) + повтор после освобождения
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("случайные расписания (seed %i): каждая пара оплачена ≤ 1 раза", async (seed) => {
    let s = seed * 2654435761 >>> 0;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const g = gated();
    const { decide } = setup(g.f);
    const pool = ["a", "b", "c", "d", "e", "f"];
    const all: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      const texts = pool.filter(() => rnd() < 0.45);
      if (texts.length === 0) continue;
      all.push(decide(vreq(texts)));
      if (rnd() < 0.3) await tick();
      if (rnd() < 0.1) g.release();
    }
    g.release();
    const rs = (await Promise.all(all)) as any[];
    expect(rs.every((r) => r.ok)).toBe(true);
    for (const [k, n] of g.paid) expect(n, k).toBe(1);
    const fresh: any = await decide(vreq(pool)); // все пары в кэше или платятся один раз
    for (const [k, n] of g.paid) expect(n, k).toBeLessThanOrEqual(1);
    expect(fresh.ok).toBe(true);
  });
});
