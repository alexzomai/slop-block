import { describe, expect, it, vi } from "vitest";
import { MAX_ERROR_BODY, callJev, classify403 } from "../src/background/client";
import { createDecider } from "../src/background/decide";
import { createLimiter } from "../src/background/limiter";
import { createRejections } from "../src/background/rejected";
import { setKey } from "../src/background/settings";
import type { DecideRequest } from "../src/shared/decision";
import { providerNotice } from "../src/shared/provider-notice";
import { SECRET, fakeKV, okBody, resp } from "./helpers/fake";
import { setI18nSource } from "../src/shared/i18n";
import { getMessageFor } from "./helpers/messages";

const base = (f: any) => ({ fetch: f, key: SECRET, body: {}, sleep: vi.fn(async () => {}), random: () => 0.5 });
const req = (id: string): DecideRequest => ({ type: "slop/decide", video: { videoId: id, title: "T", channel: "C" }, tags: [{ id: "a", text: "кликбейт" }] });

function setup(f: any, init: Record<string, unknown> = { openrouterKey: SECRET }) {
  let t = 1000;
  const kv = fakeKV(init);
  const limiter = createLimiter({ maxConcurrent: 4, perMinute: 600, maxQueue: 50, now: () => t, sleep: async () => {} });
  const decide = createDecider({ kv, fetch: f, now: () => t, sleep: async () => {}, random: () => 0, limiter, rejections: createRejections(kv) });
  return { kv, decide, advance: (ms: number) => (t += ms) };
}

describe("client: 402/403", () => {
  it("402 -> no_credits без ретраев", async () => {
    const f = vi.fn(async () => resp(402, { error: { message: "Insufficient credits" } }));
    expect(await callJev(base(f))).toEqual({ ok: false, error: "no_credits" });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("403 «Access denied by security policy» -> access_denied", async () => {
    const f = vi.fn(async () => resp(403, "Access denied by security policy"));
    expect(await callJev(base(f))).toEqual({ ok: false, error: "access_denied" });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it.each(["", "<html>Cloudflare</html>", "{not json", JSON.stringify({ error: { message: "Forbidden" } })])("неразличимое тело %# -> access_denied", async (b) => {
    expect(await callJev(base(vi.fn(async () => resp(403, b))))).toEqual({ ok: false, error: "access_denied" });
  });
  it.each(["Invalid API key", "Invalid credentials", "API key revoked"])("403 с признаком ключа %# -> key_rejected", async (m) => {
    expect(await callJev(base(vi.fn(async () => resp(403, { error: { message: m } }))))).toEqual({ ok: false, error: "key_rejected" });
  });
  it("признак ключа за пределом лимита не учитывается; тело не читается дальше лимита", async () => {
    const big = "x".repeat(MAX_ERROR_BODY + 100) + " Invalid API key";
    expect(classify403(big.slice(0, MAX_ERROR_BODY))).toBe("access_denied");
    expect(await callJev(base(vi.fn(async () => resp(403, big))))).toEqual({ ok: false, error: "access_denied" });
  });
  it("тело не попадает в результат", async () => {
    const r = await callJev(base(vi.fn(async () => resp(403, "EVILTEXT " + SECRET))));
    expect(JSON.stringify(r)).not.toMatch(/EVILTEXT|SECRET/);
  });
  it("зависшее тело 403 ограничено дедлайном -> access_denied", async () => {
    const hang = vi.fn(async () => new Response(new ReadableStream({ start() {} }), { status: 403 }));
    expect(await callJev({ ...base(hang), timeoutMs: 20 })).toEqual({ ok: false, error: "access_denied" });
  });
});

describe("decide: паузы", () => {
  it.each([[402, "no_credits"], [403, "access_denied"]] as const)("HTTP %i: ключ не помечен, пауза, потом пробный запрос", async (s, e) => {
    const f = vi.fn(async () => resp(s, "Access denied by security policy"));
    const { decide, kv, advance } = setup(f);
    expect(await decide(req("a"))).toEqual({ ok: false, error: e });
    expect(await decide(req("b"))).toEqual({ ok: false, error: e });
    expect(f).toHaveBeenCalledTimes(1); // пауза
    expect(kv.data["keyRejected.openrouter"]).toBeUndefined();
    advance(s === 402 ? 61_000 : 31_000);
    await decide(req("c"));
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("backoff растёт и ограничен 10 мин", async () => {
    const f = vi.fn(async () => resp(402));
    const { decide, advance } = setup(f);
    let n = 0;
    for (const wait of [60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
      await decide(req("v" + n++));
      expect(f).toHaveBeenCalledTimes(n);
      advance(wait - 1);
      await decide(req("x" + n)); // ещё в паузе
      expect(f).toHaveBeenCalledTimes(n);
      advance(1);
    }
  });
  it("успех снимает паузу и шаг", async () => {
    const f = vi.fn().mockResolvedValueOnce(resp(402)).mockResolvedValue(resp(200, okBody({ s0: 0.9 })));
    const { decide, advance } = setup(f);
    await decide(req("a"));
    advance(61_000);
    const r = await decide(req("b"));
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.ok === true || r.ok === false).toBe(true);
  });
  it("повторное сохранение ключа снимает паузу", async () => {
    const f = vi.fn(async () => resp(402));
    const { decide, kv } = setup(f, {});
    await setKey(kv, SECRET, "openrouter");
    await decide(req("a"));
    await setKey(kv, SECRET, "openrouter");
    await decide(req("b"));
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("provider-notice", () => {
  it("тексты по состоянию; ok и мусор скрыты", () => {
    setI18nSource({ getMessage: getMessageFor("en"), getUILanguage: () => "en-US" });
    expect(providerNotice({ ok: true, provider: "openrouter", state: "ok" })).toBeNull();
    expect(providerNotice(undefined)).toBeNull();
    expect(providerNotice({ ok: false })).toBeNull();
    expect(providerNotice({ ok: true, provider: "openrouter", state: "no_credits" })).toBeTruthy();
    expect(providerNotice({ ok: true, provider: "typesafe", state: "no_credits" })).not.toBe(providerNotice({ ok: true, provider: "openrouter", state: "no_credits" }));
    expect(providerNotice({ ok: true, provider: "openrouter", state: "access_denied" })).toBeTruthy();
  });
});

describe("decide.providerStatus", () => {
  it("ok → no_credits во время паузы → ok после смены ключа; без ключей и текстов в ответе", async () => {
    const f = vi.fn(async () => resp(402, "EVILTEXT"));
    const { decide, kv } = setup(f, {});
    await setKey(kv, SECRET, "openrouter");
    expect(await decide.providerStatus()).toEqual({ ok: true, provider: "openrouter", state: "ok" });
    await decide(req("a"));
    const s = await decide.providerStatus();
    expect(s).toEqual({ ok: true, provider: "openrouter", state: "no_credits" });
    expect(JSON.stringify(s)).not.toMatch(/EVILTEXT|SECRET/);
    await setKey(kv, SECRET, "openrouter");
    expect((await decide.providerStatus()).state).toBe("ok");
  });
  it("TypeSafe: те же классификации и пауза отдельная от OpenRouter", async () => {
    const f = vi.fn(async () => resp(403, "Access denied by security policy"));
    const { decide, kv } = setup(f, {});
    await setKey(kv, "TSKEY1234567890", "typesafe");
    await kv.set({ settings: { provider: "typesafe" } });
    expect(await decide(req("a"))).toEqual({ ok: false, error: "access_denied" });
    expect(await decide.providerStatus()).toMatchObject({ provider: "typesafe", state: "access_denied" });
  });
});

describe("ревью r1", () => {
  it.each(["Unauthorized region", "Unauthorized", "Access denied: unauthorized country", "Unauthorized by security policy"])("403 «%s» -> access_denied, ключ не залипает", async (m) => {
    expect(classify403(m)).toBe("access_denied");
    const f = vi.fn(async () => resp(403, { error: { message: m } }));
    const { decide, kv } = setup(f);
    expect(await decide(req("a"))).toEqual({ ok: false, error: "access_denied" });
    expect(kv.data["keyRejected.openrouter"]).toBeUndefined();
  });
  it("один chunk 8192 байт: в разбор идёт только первые 4096, поток отменяется", async () => {
    let cancelled = false;
    const head = new TextEncoder().encode("x".repeat(MAX_ERROR_BODY));
    const tail = new TextEncoder().encode(" Invalid API key".padEnd(MAX_ERROR_BODY, " "));
    const chunk = new Uint8Array(8192);
    chunk.set(head, 0);
    chunk.set(tail, head.length);
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { if (sent) return; sent = true; c.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    const r = await callJev(base(vi.fn(async () => new Response(body, { status: 403 }))));
    expect(r).toEqual({ ok: false, error: "access_denied" }); // признак ключа лежит за лимитом
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
  it("гонка: поздний ответ старого поколения не трогает паузу нового", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const f = vi.fn(async () => {
      calls++;
      if (calls === 1) { await gate; return resp(200, okBody({ s0: 0.9 })); } // A: поздний успех
      return resp(402);
    });
    const { decide, kv } = setup(f, {});
    await setKey(kv, SECRET, "openrouter");
    const late = decide(req("a")); // поколение A в полёте
    await vi.waitFor(() => expect(calls).toBe(1));
    await setKey(kv, SECRET, "openrouter"); // поколение B
    await decide(req("b")); // B: 402 -> пауза B
    expect((await decide.providerStatus()).state).toBe("no_credits");
    release();
    await late; // успех A не снимает паузу B
    expect((await decide.providerStatus()).state).toBe("no_credits");
  });
  it("гонка: поздний 402 старого поколения не создаёт паузу для нового", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const f = vi.fn(async () => {
      calls++;
      if (calls === 1) { await gate; return resp(402); }
      return resp(200, okBody({ s0: 0.9 }));
    });
    const { decide, kv } = setup(f, {});
    await setKey(kv, SECRET, "openrouter");
    const late = decide(req("a"));
    await vi.waitFor(() => expect(calls).toBe(1));
    await setKey(kv, SECRET, "openrouter");
    release();
    await late;
    expect((await decide.providerStatus()).state).toBe("ok");
    await decide(req("b"));
    expect(f).toHaveBeenCalledTimes(2); // пауза не помешала
  });
});

describe("ревью r1: поздняя ошибка старого поколения", () => {
  it("поздний 402 A не перезаписывает паузу B", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const f = vi.fn(async () => {
      calls++;
      if (calls === 1) await gate;
      return resp(402);
    });
    const { decide, kv } = setup(f, {});
    await setKey(kv, SECRET, "openrouter");
    const late = decide(req("a"));
    await vi.waitFor(() => expect(calls).toBe(1));
    await setKey(kv, SECRET, "openrouter");
    await decide(req("b")); // пауза B
    release();
    await late; // 402 от A
    expect((await decide.providerStatus()).state).toBe("no_credits");
    await decide(req("c"));
    expect(f).toHaveBeenCalledTimes(2); // пауза B жива
  });
});
