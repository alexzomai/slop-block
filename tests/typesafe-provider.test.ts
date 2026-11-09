import { describe, expect, it, vi } from "vitest";
import { createDecider } from "../src/background/decide";
import { createLimiter } from "../src/background/limiter";
import { PROVIDERS, cacheNamespace, canonicalModel, parseProvider } from "../src/background/providers";
import { activeModel, getSettings, saveSettings } from "../src/background/settings";
import { createUsageService } from "../src/background/usage";
import { loadView, onRemoveKey, onSaveKey, onSaveSettings } from "../src/options/controller";
import type { DecideRequest } from "../src/shared/decision";
import { usageView } from "../src/popup/usage";
import { setI18nSource } from "../src/shared/i18n";
import { getMessageFor } from "./helpers/messages";
import { SECRET, fakeKV, okBody, resp } from "./helpers/fake";

const TS_KEY = "ts-key-TYPESAFESECRET1234";
const OR_URL = "https://openrouter.ai/api/v1/systemone";
const TS_URL = "https://api.typesafe.ai/v1/systemone";

const req = (videoId = "v1"): DecideRequest => ({
  type: "slop/decide",
  video: { videoId, title: "T", channel: "C" },
  tags: [{ id: "a", text: "кликбейт" }],
});

function setup(init: Record<string, unknown>, fetchImpl: any, extra: Partial<Parameters<typeof createDecider>[0]> = {}) {
  const kv = fakeKV(init);
  const decide = createDecider({ kv, fetch: fetchImpl, now: () => 1000, sleep: async () => {}, random: () => 0, ...extra });
  return { kv, decide };
}
const tsSettings = { settings: { provider: "typesafe", model: "typesafe/jev-1.13", modelTypesafe: "jev-1.13.0", threshold: 0.7 } };

describe("providers", () => {
  it("parseProvider: только typesafe, иначе openrouter", () => {
    expect(parseProvider("typesafe")).toBe("typesafe");
    for (const v of [undefined, "x", 5, null, "OpenRouter"]) expect(parseProvider(v)).toBe("openrouter");
  });
  it("адреса и ключи", () => {
    expect(PROVIDERS.openrouter).toMatchObject({ endpoint: OR_URL, keyStorage: "openrouterKey", hasBalanceApi: true });
    expect(PROVIDERS.typesafe).toMatchObject({ endpoint: TS_URL, keyStorage: "typesafeKey", defaultModel: "jev-1.13.0", hasBalanceApi: false });
  });
  it("каноническая модель и пространство кэша", () => {
    expect(canonicalModel("typesafe/jev-1.13")).toBe("jev-1.13");
    expect(canonicalModel(" Jev-1.13.0 ")).toBe("jev-1.13");
    expect(cacheNamespace("typesafe/jev-1.13")).toBe("");
    expect(cacheNamespace("jev-1.13.0")).toBe("");
    expect(cacheNamespace("jev-1.14.0")).toBe("jev-1.14");
    expect(cacheNamespace("jev-latest")).toBe("jev-latest");
  });
});

describe("миграция настроек", () => {
  it("без provider: OpenRouter, прежние поля и ключ работают без записи", async () => {
    const f = vi.fn(async () => resp(200, okBody({ t0: 0.9 })));
    const { decide, kv } = setup({ openrouterKey: SECRET, settings: { model: "x/y", threshold: 0.5 } }, f);
    const before = JSON.stringify(kv.data.settings);
    expect(((await decide(req())) as any).hide).toBe(true);
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe(OR_URL);
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(init.body).model).toBe("x/y");
    expect(JSON.stringify(kv.data.settings)).toBe(before);
    expect(await getSettings(kv)).toMatchObject({ provider: "openrouter", model: "x/y", modelTypesafe: "jev-1.13.0" });
  });
  it("saveSettings без provider сохраняет выбранный ранее", async () => {
    const kv = fakeKV(tsSettings);
    await saveSettings(kv, { model: "m", threshold: 0.3 });
    expect(await getSettings(kv)).toMatchObject({ provider: "typesafe", model: "m" });
    await saveSettings(kv, { model: "m", threshold: 0.3, provider: "openrouter", modelTypesafe: "jev-1.14.0" });
    const s = await getSettings(kv);
    expect(s.provider).toBe("openrouter");
    expect(activeModel({ ...s, provider: "typesafe" })).toBe("jev-1.14.0");
    expect(await saveSettings(kv, { model: "m", threshold: 0.3, modelTypesafe: "  " })).toEqual({ ok: false, code: "model_required" });
  });
});

describe("TypeSafe: запрос и разбор", () => {
  it("POST api.typesafe.ai с Bearer-ключом TypeSafe, модель jev-1.13.0, тело System One", async () => {
    const f = vi.fn(async () => resp(200, { model: "jev-1.13.0", answers: { t0: { type: "noul", noul: 0.95 } }, usage: { input_tokens: 120, output_tokens: 3 } }));
    const { decide } = setup({ typesafeKey: TS_KEY, openrouterKey: SECRET, ...tsSettings }, f);
    expect(await decide(req())).toEqual({ ok: true, hide: true, matchedTagIds: ["a"], probabilities: { a: 0.95 } });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe(TS_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: `Bearer ${TS_KEY}`, "Content-Type": "application/json" });
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body.model).toBe("jev-1.13.0");
    expect(body.questions.t0).toMatchObject({ type: "noul", criteria: { true: expect.any(String), false: expect.any(String) } });
    expect(JSON.stringify(init)).not.toContain(SECRET);
  });
  it("ключ OpenRouter не уходит в TypeSafe, ключ TypeSafe — в OpenRouter", async () => {
    const f = vi.fn(async () => resp(200, okBody({ t0: 0.9 })));
    const a = setup({ openrouterKey: SECRET, ...tsSettings }, f);
    expect(await a.decide(req())).toEqual({ ok: false, error: "no_key" });
    const b = setup({ typesafeKey: TS_KEY, settings: { provider: "openrouter" } }, f);
    expect(await b.decide(req())).toEqual({ ok: false, error: "no_key" });
    expect(f).not.toHaveBeenCalled();
  });
  it("0 вызовов к OpenRouter при TypeSafe и к TypeSafe при OpenRouter", async () => {
    const f = vi.fn(async () => resp(200, okBody({ t0: 0.9 })));
    const kvInit = { typesafeKey: TS_KEY, openrouterKey: SECRET };
    await setup({ ...kvInit, ...tsSettings }, f).decide(req("x1"));
    await setup({ ...kvInit, settings: { provider: "openrouter" } }, f).decide(req("x2"));
    expect(f.mock.calls.map((c: any) => c[0])).toEqual([TS_URL, OR_URL]);
  });
  it.each([
    [401, "no_key"], [429, "rate_limited"], [529, "network"], [500, "network"], [400, "bad_response"], [422, "bad_response"],
  ])("HTTP %i -> %s, ключ и текст сервера не в ответе", async (status, error) => {
    const f = vi.fn(async () => resp(status, { detail: `SERVERTEXT ${TS_KEY}` }));
    const { decide } = setup({ typesafeKey: TS_KEY, ...tsSettings }, f);
    const r = await decide(req());
    expect(r).toEqual({ ok: false, error });
    expect(JSON.stringify(r)).not.toMatch(/SERVERTEXT|TYPESAFESECRET/);
  });
  it("429 с Retry-After: ретрай и успех", async () => {
    const f = vi.fn().mockResolvedValueOnce(resp(429, {}, { "retry-after": "2" })).mockResolvedValueOnce(resp(200, okBody({ t0: 0.9 })));
    const sleep = vi.fn(async () => {});
    const { decide } = setup({ typesafeKey: TS_KEY, ...tsSettings }, f, { sleep });
    expect(((await decide(req())) as any).ok).toBe(true);
    expect(sleep).toHaveBeenCalledWith(2000);
  });
  it("ответ без answers -> bad_response", async () => {
    const { decide } = setup({ typesafeKey: TS_KEY, ...tsSettings }, vi.fn(async () => resp(200, { model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 } })));
    expect(await decide(req())).toEqual({ ok: false, error: "bad_response" });
  });
});

describe("кэш и счётчики между провайдерами", () => {
  it("та же модель (typesafe/jev-1.13 ≡ jev-1.13.0): платный вызов не повторяется при смене провайдера", async () => {
    const f = vi.fn(async () => resp(200, okBody({ t0: 0.9 })));
    const { decide, kv } = setup({ openrouterKey: SECRET, typesafeKey: TS_KEY }, f);
    await decide(req());
    await kv.set(tsSettings);
    expect(((await decide(req())) as any).hide).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("другая версия модели — отдельное пространство кэша", async () => {
    const f = vi.fn(async () => resp(200, okBody({ t0: 0.9 })));
    const { decide, kv } = setup({ typesafeKey: TS_KEY, ...tsSettings }, f);
    await decide(req());
    await kv.set({ settings: { ...tsSettings.settings, modelTypesafe: "jev-1.14.0" } });
    await decide(req());
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse((f.mock.calls[1] as any)[1].body).model).toBe("jev-1.14.0");
    await decide(req()); // теперь 1.14 в кэше
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("счётчики токенов раздельные: usageStatsTypesafe и usageStats", async () => {
    const f = vi.fn(async () => resp(200, okBody({ t0: 0.9 })));
    const { decide, kv } = setup({ openrouterKey: SECRET, typesafeKey: TS_KEY, ...tsSettings }, f);
    await decide(req("a1"));
    expect(kv.data.usageStats).toBeUndefined();
    expect(kv.data.usageStatsTypesafe).toMatchObject({ requestsTotal: 1, tokensTotal: 100 });
  });
  it("общий лимитер: каждый fetch обоих провайдеров идёт через один limiter.run", async () => {
    const f = vi.fn(async () => resp(200, okBody({ t0: 0.9 })));
    const limiter = createLimiter({ maxConcurrent: 4, perMinute: 60, maxQueue: 50, now: () => 1000, sleep: async () => {} });
    const run = vi.spyOn(limiter, "run");
    const { decide, kv } = setup({ openrouterKey: SECRET, typesafeKey: TS_KEY, ...tsSettings }, f, { limiter });
    await decide(req("l1"));
    await kv.set({ settings: { provider: "openrouter" } });
    await decide(req("l2"));
    expect(f).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("дедлайн: зависший fetch TypeSafe не блокирует ответ (fail-open: network)", async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn((_u: unknown, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("abort")))));
      const { decide } = setup({ typesafeKey: TS_KEY, ...tsSettings }, f);
      const p = decide(req());
      await vi.advanceTimersByTimeAsync(15_000 * 3 + 5000);
      expect(await p).toEqual({ ok: false, error: "network" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("траты", () => {
  const mk = (init: Record<string, unknown>, f: any) =>
    createUsageService({ kv: fakeKV(init), fetch: f, now: () => 1000, sleep: async () => {}, random: () => 0, limiter: createLimiter({ maxConcurrent: 4, perMinute: 60, maxQueue: 50, now: () => 1000, sleep: async () => {} }) });
  it("TypeSafe с ключом: без сети, remote=null, локальные цифры TypeSafe", async () => {
    const f = vi.fn();
    const r = await mk({ typesafeKey: TS_KEY, openrouterKey: SECRET, ...tsSettings, usageStatsTypesafe: { day: "1970-01-01", requestsToday: 2, tokensToday: 50, requestsTotal: 5, tokensTotal: 500 }, usageStats: { day: "1970-01-01", requestsToday: 9, tokensToday: 9, requestsTotal: 9, tokensTotal: 9 } }, f).get();
    expect(f).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, remote: null, provider: "typesafe", local: { requestsToday: 2, requestsTotal: 5, tokensToday: 50, tokensTotal: 500 } });
    expect(JSON.stringify(r)).not.toMatch(/TYPESAFESECRET|SECRETSECRET/);
  });
  it("TypeSafe без ключа -> no_key (даже если есть ключ OpenRouter)", async () => {
    const r: any = await mk({ openrouterKey: SECRET, ...tsSettings }, vi.fn()).get();
    expect(r).toMatchObject({ ok: false, error: "no_key", provider: "typesafe" });
  });
  it("OpenRouter: прежний вид ответа (без provider), запрос /key", async () => {
    const f = vi.fn(async () => resp(200, { data: { usage: 1, usage_daily: 0.1, usage_monthly: 0.5, limit: null, limit_remaining: null } }));
    const r: any = await mk({ openrouterKey: SECRET, typesafeKey: TS_KEY }, f).get();
    expect(r.ok).toBe(true);
    expect(r).not.toHaveProperty("provider");
    expect((f.mock.calls[0] as any)[0]).toBe("https://openrouter.ai/api/v1/key");
  });
  it("popup: TypeSafe — локальные цифры, подпись-оценка, без серверных сумм", () => {
    setI18nSource({ getMessage: getMessageFor("en"), getUILanguage: () => "en-US" });
    try {
    const v = usageView({ ok: true, remote: null, provider: "typesafe", local: { requestsToday: 1, requestsTotal: 2, tokensToday: 1000, tokensTotal: 2_000_000 } });
    expect(v.state).toBe("ok");
    expect(v.text).toBeTruthy();
    expect(v.rows!.length).toBe(3);
    expect(v.rows!.map((r) => r[0]).join("|")).toContain("≈");
    const nk = usageView({ ok: false, error: "no_key", provider: "typesafe", local: { requestsToday: 0, requestsTotal: 0, tokensToday: 0, tokensTotal: 0 } });
    expect(nk.state).toBe("no_key");
    expect(nk.text).toBe("TypeSafe key is not set");
    } finally {
      setI18nSource(undefined);
    }
  });
});

describe("страница настроек: контроллер", () => {
  it("ключи провайдеров независимы, значения не раскрываются", async () => {
    const kv = fakeKV();
    expect(await onSaveKey(kv, `  ${TS_KEY} `, "typesafe")).toEqual({ ok: true, key: "msg_key_saved" });
    expect(kv.data.typesafeKey).toBe(TS_KEY);
    expect(kv.data.openrouterKey).toBeUndefined();
    await onSaveKey(kv, SECRET);
    const v = await loadView(kv);
    expect(v).toMatchObject({ keySet: true, provider: "openrouter", model: "typesafe/jev-1.13", modelTypesafe: "jev-1.13.0" });
    expect(v.typesafe.keySet).toBe(true);
    expect(JSON.stringify(v)).not.toContain(TS_KEY);
    expect(JSON.stringify(v)).not.toContain(SECRET);
    await onRemoveKey(kv, "typesafe");
    expect((await loadView(kv)).typesafe.keySet).toBe(false);
    expect((await loadView(kv)).keySet).toBe(true);
    expect(await onSaveKey(kv, "  ", "typesafe")).toEqual({ ok: false, key: "msg_key_required" });
  });
  it("сохранение провайдера и модели TypeSafe", async () => {
    const kv = fakeKV();
    expect(await onSaveSettings(kv, "typesafe/jev-1.13", "0.6", "typesafe", "jev-1.14.0")).toEqual({ ok: true, key: "msg_settings_saved" });
    expect(await getSettings(kv)).toMatchObject({ provider: "typesafe", modelTypesafe: "jev-1.14.0", threshold: 0.6 });
  });
});

describe("кэш: пространство модели кодируется инъективно (ts-r1 P2-1)", () => {
  const SEP = "jev-1.14\u0001robotics";
  it("кэш: тег с U+0001 в базовой модели не совпадает с «robotics» в jev-1.14", async () => {
    const { createCache } = await import("../src/background/cache");
    const c = createCache({ kv: fakeKV(), now: () => 1000 });
    await c.set("v", [{ text: SEP, p: 0.9 }], "");
    expect(c.peek("v", [{ text: "robotics" }], "jev-1.14")).toEqual([undefined]);
    expect(c.peek("v", [{ text: SEP }], "")).toEqual([0.9]);
    await c.set("v", [{ text: "robotics", p: 0.1 }], "jev-1.14");
    expect(c.peek("v", [{ text: SEP }], "")).toEqual([0.9]);
    expect(c.peek("v", [{ text: "robotics" }], "jev-1.14")).toEqual([0.1]);
  });
  it("decide: ровно входы ревьюера — второй вызов идёт в сеть", async () => {
    const f = vi.fn().mockResolvedValueOnce(resp(200, okBody({ t0: 0.9 }))).mockResolvedValueOnce(resp(200, okBody({ t0: 0.1 })));
    const { decide, kv } = setup({ openrouterKey: SECRET, typesafeKey: TS_KEY }, f);
    const r = (text: string): DecideRequest => ({ type: "slop/decide", video: { videoId: "v1", title: "T", channel: "C" }, tags: [{ id: "a", text }] });
    expect(((await decide(r(SEP))) as any).probabilities.a).toBe(0.9);
    await kv.set({ settings: { provider: "typesafe", model: "typesafe/jev-1.13", modelTypesafe: "jev-1.14.0", threshold: 0.7 } });
    expect(((await decide(r("robotics"))) as any).probabilities.a).toBe(0.1);
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse((f.mock.calls[1] as any)[1].body).model).toBe("jev-1.14.0");
  });
  it("совместимость: запись базовой модели прежнего формата читается", async () => {
    const { createCache } = await import("../src/background/cache");
    // прежний ключ тега — чистый base36 без префикса
    const kv = fakeKV();
    const c1 = createCache({ kv, now: () => 1000 });
    await c1.set("v", [{ text: "Кликбейт", p: 0.5 }]);
    const stored = JSON.stringify(kv.data);
    expect(stored).not.toContain("~");
    const c2 = createCache({ kv, now: () => 1000 });
    expect(await c2.get("v", [{ text: "кликбейт" }], "")).toEqual([0.5]);
  });
});
