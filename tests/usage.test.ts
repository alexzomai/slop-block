import { describe, expect, it, vi } from "vitest";
import { callJev } from "../src/background/client";
import { createDecider } from "../src/background/decide";
import { createLimiter } from "../src/background/limiter";
import { parseKeyInfo, createUsageService } from "../src/background/usage";
import { SECRET, fakeKV, okBody, resp } from "./helpers/fake";

const KEY_URL = "https://openrouter.ai/api/v1/key";
const keyBody = (d: Record<string, unknown> = {}) => ({
  data: { label: "sk-or-v1-au7...890", limit: 100, limit_remaining: 74.5, usage: 25.5, usage_daily: 0.0004, usage_weekly: 3, usage_monthly: 12.25, ...d },
});

function setup(fetchImpl: any, kvInit: Record<string, unknown> = { openrouterKey: SECRET }, t = { now: 1_000_000 }) {
  const kv = fakeKV(kvInit);
  const limiter = createLimiter({ maxConcurrent: 4, perMinute: 60, maxQueue: 50, now: () => t.now, sleep: async () => {} });
  const svc = createUsageService({ kv, fetch: fetchImpl, now: () => t.now, sleep: async () => {}, random: () => 0, limiter });
  return { kv, svc, t };
}

describe("callJev GET", () => {
  it("GET: без body и Content-Type, с Authorization", async () => {
    const f = vi.fn(async () => resp(200, {}));
    await callJev({ fetch: f as any, key: SECRET, url: KEY_URL, method: "GET", sleep: async () => {}, random: () => 0 });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe(KEY_URL);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers["Content-Type"]).toBeUndefined();
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
  });
});

describe("parseKeyInfo", () => {
  it("лимит задан", () => {
    expect(parseKeyInfo(keyBody())).toEqual({ usage: 25.5, usageDaily: 0.0004, usageMonthly: 12.25, limit: 100, limitRemaining: 74.5 });
  });
  it("лимита нет", () => {
    expect(parseKeyInfo(keyBody({ limit: null, limit_remaining: null }))).toMatchObject({ limit: null, limitRemaining: null });
  });
  it.each([
    ["null", null], ["нет data", {}], ["usage строка", keyBody({ usage: "1" })], ["нет usage_daily", keyBody({ usage_daily: undefined })],
    ["usage NaN-подобное", keyBody({ usage: null })], ["usage < 0", keyBody({ usage: -1 })], ["limit < 0", keyBody({ limit: -5 })],
    ["limit_remaining строка", keyBody({ limit_remaining: "7" })], ["limit_remaining отсутствует", keyBody({ limit_remaining: undefined })],
  ])("невалидно (%s) → null", (_n, j) => expect(parseKeyInfo(j)).toBeNull());
});

describe("usage service", () => {
  it("успех: remote + local, запрос на /key с ключом", async () => {
    const f = vi.fn(async () => resp(200, keyBody()));
    const { svc } = setup(f);
    const r = await svc.get();
    expect(r).toEqual({ ok: true, remote: { usage: 25.5, usageDaily: 0.0004, usageMonthly: 12.25, limit: 100, limitRemaining: 74.5 }, local: { requestsToday: 0, requestsTotal: 0, tokensToday: 0, tokensTotal: 0 } });
    expect((f.mock.calls[0] as any)[0]).toBe(KEY_URL);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
  it("нет ключа → no_key без fetch", async () => {
    const f = vi.fn();
    const { svc } = setup(f, {});
    expect(await svc.get()).toMatchObject({ ok: false, error: "no_key" });
    expect(f).not.toHaveBeenCalled();
  });
  it("401 с текстом ошибки → no_key, текста сервера нет", async () => {
    const { svc } = setup(vi.fn(async () => resp(401, { error: { message: `bad key ${SECRET} EVILTEXT` } })));
    const r = await svc.get();
    expect(r).toMatchObject({ ok: false, error: "no_key" });
    expect(JSON.stringify(r)).not.toMatch(/EVILTEXT|SECRET/);
  });
  it.each([[429, "rate_limited"], [503, "network"], [403, "bad_response"], [400, "bad_response"]])("HTTP %i → %s", async (s, e) => {
    const { svc } = setup(vi.fn(async () => resp(s, { error: { message: "EVILTEXT" } })));
    const r = await svc.get();
    expect(r).toMatchObject({ ok: false, error: e });
    expect(JSON.stringify(r)).not.toContain("EVILTEXT");
  });
  it("429 затем успех → ретрай через общий callJev", async () => {
    const f = vi.fn().mockResolvedValueOnce(resp(429)).mockResolvedValueOnce(resp(200, keyBody()));
    const { svc } = setup(f);
    expect(await svc.get()).toMatchObject({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("сеть → network", async () => {
    const { svc } = setup(vi.fn(async () => { throw new Error(`boom ${SECRET}`); }));
    const r = await svc.get();
    expect(r).toMatchObject({ ok: false, error: "network" });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });
  it.each([["не JSON", "<html>"], ["нет data", {}], ["usage не число", keyBody({ usage: "x" })]])("некорректное тело (%s) → bad_response", async (_n, b) => {
    const { svc } = setup(vi.fn(async () => resp(200, b as any)));
    expect(await svc.get()).toMatchObject({ ok: false, error: "bad_response" });
  });
  it("переполнение очереди лимитера → rate_limited", async () => {
    const kv = fakeKV({ openrouterKey: SECRET });
    const limiter = createLimiter({ maxConcurrent: 1, perMinute: 60, maxQueue: 0, now: () => 0, sleep: async () => {} });
    const f = vi.fn(async () => resp(200, keyBody()));
    const svc = createUsageService({ kv, fetch: f as any, now: () => 0, sleep: async () => {}, random: () => 0, limiter });
    // maxQueue 0 → первая же попытка не помещается
    expect(await svc.get()).toMatchObject({ ok: false, error: "rate_limited" });
    expect(f).not.toHaveBeenCalled();
  });
  it("кэш 60 с: повтор без fetch; после 60 с — новый запрос; local всегда свежий", async () => {
    const f = vi.fn(async () => resp(200, keyBody()));
    const { svc, t, kv } = setup(f);
    await svc.get();
    t.now += 30_000;
    await kv.set({ usageStats: { day: new Date(t.now).toISOString().slice(0, 10), requestsToday: 3, tokensToday: 9, requestsTotal: 4, tokensTotal: 10 } });
    const r2 = await svc.get();
    expect(f).toHaveBeenCalledTimes(1);
    expect(r2).toMatchObject({ ok: true, local: { requestsToday: 3, tokensTotal: 10 } });
    t.now += 31_000;
    await svc.get();
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("одновременные запросы объединяются", async () => {
    const f = vi.fn(async () => resp(200, keyBody()));
    const { svc } = setup(f);
    await Promise.all([svc.get(), svc.get(), svc.get()]);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("ошибки не кэшируются", async () => {
    const f = vi.fn().mockResolvedValueOnce(resp(400)).mockResolvedValueOnce(resp(200, keyBody()));
    const { svc } = setup(f);
    expect(await svc.get()).toMatchObject({ ok: false });
    expect(await svc.get()).toMatchObject({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("смена ключа и удаление сбрасывают кэш; данные прежнего ключа не показываются", async () => {
    const f = vi.fn().mockResolvedValueOnce(resp(200, keyBody({ usage: 1 }))).mockResolvedValueOnce(resp(200, keyBody({ usage: 2 })));
    const { svc, kv } = setup(f);
    expect((await svc.get() as any).remote.usage).toBe(1);
    await kv.set({ openrouterKey: SECRET + "2" });
    expect((await svc.get() as any).remote.usage).toBe(2);
    await kv.remove("openrouterKey");
    expect(await svc.get()).toMatchObject({ ok: false, error: "no_key" });
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("decide ↔ счётчик", () => {
  const req = { type: "slop/decide", video: { videoId: "v1", title: "T", channel: "C" }, tags: [{ id: "a", text: "x" }] };
  const mk = (f: any, kv = fakeKV({ openrouterKey: SECRET })) => {
    const d = createDecider({ kv, fetch: f, now: () => Date.UTC(2026, 10, 6), sleep: async () => {}, random: () => 0 });
    return { kv, d };
  };
  it("2xx Jev считается; попадание в кэш — нет", async () => {
    const f = vi.fn(async () => resp(200, okBody({ t0: 0.1 })));
    const { d, kv } = mk(f);
    await d(req); await d(req);
    expect((kv.data.usageStats as any)).toMatchObject({ requestsToday: 1, requestsTotal: 1, tokensToday: 100, tokensTotal: 100 });
  });
  it("ошибка и невалидный запрос не считаются", async () => {
    const { d, kv } = mk(vi.fn(async () => resp(400)));
    await d(req); await d(null);
    expect(kv.data.usageStats).toBeUndefined();
  });
  it("запрос оплачен, даже если ответ не разобран (bad_response) — считается", async () => {
    const { d, kv } = mk(vi.fn(async () => resp(200, { answers: {}, usage: { input_tokens: 7 } })));
    expect(await d(req)).toEqual({ ok: false, error: "bad_response" });
    expect((kv.data.usageStats as any).tokensTotal).toBe(7);
  });
  it("сбой записи счётчика не ломает решение", async () => {
    const kv = fakeKV({ openrouterKey: SECRET });
    const orig = kv.set.bind(kv);
    kv.set = async (i) => { if ("usageStats" in i) throw new Error("quota"); return orig(i); };
    const { d } = mk(vi.fn(async () => resp(200, okBody({ t0: 0.9 }))), kv);
    expect(await d(req)).toMatchObject({ ok: true, hide: true });
  });
  it("single-flight: N одновременных decide по одной паре — один платный вызов, учтён ровно один раз", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = vi.fn(async () => { await gate; return resp(200, okBody({ t0: 0.1 })); });
    const { d, kv } = mk(f);
    const ps = [d(req), d(req), d(req), d(req)];
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    release();
    const rs = await Promise.all(ps);
    expect(rs.every((r: any) => r.ok)).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(kv.data.usageStats).toMatchObject({ requestsToday: 1, requestsTotal: 1, tokensToday: 100, tokensTotal: 100 });
  });
  it("частичный кэш: платный вызов только за недостающие пары — учтён один раз; полное попадание — не учитывается", async () => {
    const f = vi.fn(async () => resp(200, okBody({ t0: 0.1 })));
    const { d, kv } = mk(f);
    await d(req); // пара «x» — 1 вызов
    await d({ ...req, tags: [{ id: "a", text: "x" }, { id: "b", text: "новый" }] }); // только «новый» — 1 вызов
    await d({ ...req, tags: [{ id: "a", text: "x" }, { id: "b", text: "новый" }] }); // всё из кэша — 0
    expect(f).toHaveBeenCalledTimes(2);
    expect((kv.data.usageStats as any).requestsTotal).toBe(2);
  });
});
