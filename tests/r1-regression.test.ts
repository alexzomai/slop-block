import { expect, it, vi } from "vitest";
import { callJev } from "../src/background/client";
import { createDecider } from "../src/background/decide";
import { fakeKV, okBody, resp } from "./helpers/fake";

const KEY = "review-fixture-not-real";
const mk = (i: number, tags = 1) => ({
  type: "slop/decide",
  video: { videoId: `video${i}`, title: "T", channel: "C" },
  tags: Array.from({ length: tags }, (_, k) => ({ id: `a${k}`, text: "tag" })),
});

function maxInWindow(stamps: number[], win = 60_000): number {
  const s = [...stamps].sort((a, b) => a - b);
  let max = 0;
  for (let i = 0, j = 0; i < s.length; i++) {
    while (s[i]! - s[j]! > win) j++;
    max = Math.max(max, i - j + 1);
  }
  return max;
}

it("r1-1: retries pass through the per-minute budget (21 decisions x 503)", async () => {
  let clock = 0;
  const stamps: number[] = [];
  const decide = createDecider({
    kv: fakeKV({ openrouterKey: KEY }), now: () => clock, sleep: async (ms) => { clock += ms; }, random: () => 0,
    fetch: (async () => { stamps.push(clock); return resp(503); }) as typeof fetch,
  });
  for (let i = 0; i < 21; i++) expect(await decide(mk(i))).toEqual({ ok: false, error: "network" });
  expect(stamps).toHaveLength(63);
  expect(maxInWindow(stamps)).toBeLessThanOrEqual(60);
});

it("r1-1: in any 60s window fetch calls <= 60 for random 429/5xx/Retry-After/network mixes", async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    let s = seed;
    const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    let clock = 0;
    const stamps: number[] = [];
    const decide = createDecider({
      kv: fakeKV({ openrouterKey: KEY }), now: () => clock, sleep: async (ms) => { clock += ms; }, random: rnd,
      fetch: (async () => {
        stamps.push(clock);
        const r = rnd();
        if (r < 0.2) throw new TypeError("net");
        if (r < 0.4) return resp(429, {}, rnd() < 0.5 ? { "retry-after": String(Math.floor(rnd() * 20)) } : {});
        if (r < 0.7) return resp(503);
        return resp(200, okBody({ t0: 0.5 }));
      }) as typeof fetch,
    });
    await Promise.all(Array.from({ length: 80 }, (_, i) => decide(mk(i))));
    expect(stamps.length).toBeGreaterThan(80);
    expect(maxInWindow(stamps)).toBeLessThanOrEqual(60);
  }
});

it("r1-1: parallelism <= 6 with retries in flight", async () => {
  let active = 0, peak = 0, clock = 0;
  const decide = createDecider({
    kv: fakeKV({ openrouterKey: KEY }), now: () => clock, sleep: async (ms) => { clock += ms; }, random: () => 0,
    fetch: (async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 2)); active--; return resp(503); }) as typeof fetch,
  });
  await Promise.all(Array.from({ length: 30 }, (_, i) => decide(mk(i))));
  expect(peak).toBeLessThanOrEqual(6);
});

function hangingBody(onSignal: (s: AbortSignal) => void, bindAbort = true) {
  return (async (_u: unknown, init: RequestInit) => {
    onSignal(init.signal!);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("{}"));
        if (bindAbort) init.signal!.addEventListener("abort", () => c.error(new DOMException("Aborted", "AbortError")));
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

it.each([true, false])("r1-2: 200 with never-closing body -> network exactly at timeout (stream bound to signal: %s)", async (bound) => {
  vi.useFakeTimers();
  try {
    let signal!: AbortSignal;
    let settled = false;
    const p = callJev({ key: KEY, body: {}, random: () => 0, sleep: async () => {}, maxAttempts: 1, fetch: hangingBody((s) => (signal = s), bound) })
      .then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toEqual({ ok: false, error: "network" });
    expect(signal.aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("r1-2: hanging body releases the limiter slot", async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const fetchImpl = (async (u: unknown, init: RequestInit) => {
      if (++calls === 1) return (hangingBody(() => {}) as any)(u, init);
      return resp(200, okBody({ t0: 0.9 }));
    }) as typeof fetch;
    const decide = createDecider({
      kv: fakeKV({ openrouterKey: KEY }), now: () => Date.now(), sleep: async () => {}, random: () => 0, fetch: fetchImpl,
      limits: { maxConcurrent: 1, perMinute: 100, maxQueue: 5 },
    });
    const p1 = decide(mk(1));
    const p2 = decide(mk(2));
    await vi.advanceTimersByTimeAsync(16_000);
    expect((await p2)).toMatchObject({ ok: true });
    expect(await p1).toMatchObject({ ok: true }); // 2-я попытка p1 (calls>1) успешна
  } finally { vi.useRealTimers(); }
});

it("r1-2: fully read invalid json / schema -> bad_response, body read error -> network", async () => {
  const bad = await callJev({ key: KEY, body: {}, random: () => 0, sleep: async () => {}, fetch: (async () => resp(200, "not json")) as typeof fetch });
  expect(bad).toEqual({ ok: false, error: "bad_response" });
  const broken = (async () => new Response(new ReadableStream({ start(c) { c.error(new Error("reset")); } }), { status: 200 })) as unknown as typeof fetch;
  expect(await callJev({ key: KEY, body: {}, random: () => 0, sleep: async () => {}, maxAttempts: 1, fetch: broken })).toEqual({ ok: false, error: "network" });
});
