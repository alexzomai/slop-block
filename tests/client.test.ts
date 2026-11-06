import { describe, expect, it, vi } from "vitest";
import { callJev } from "../src/background/client";
import { SECRET, okBody, resp } from "./helpers/fake";

const base = (fetchImpl: any) => ({ fetch: fetchImpl, key: SECRET, body: { model: "m" }, sleep: vi.fn<(ms: number) => Promise<void>>(async () => {}), random: () => 0.5 });

describe("callJev", () => {
  it("sends bearer key to openrouter only", async () => {
    const f = vi.fn(async () => resp(200, okBody({ t0: 0.5 })));
    const r = await callJev(base(f));
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
  });
  it("429 then success -> 2 calls", async () => {
    const f = vi.fn().mockResolvedValueOnce(resp(429, {}, { "retry-after": "1" })).mockResolvedValueOnce(resp(200, okBody({ t0: 0.5 })));
    const o = base(f);
    const r = await callJev(o);
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
    expect(o.sleep).toHaveBeenCalledWith(1000);
  });
  it("Retry-After capped at 10s", async () => {
    const f = vi.fn().mockResolvedValueOnce(resp(429, {}, { "retry-after": "999" })).mockResolvedValueOnce(resp(200, okBody({})));
    const o = base(f);
    await callJev(o);
    expect(o.sleep).toHaveBeenCalledWith(10000);
  });
  it("persistent 503 -> network after 3 calls, exponential backoff", async () => {
    const f = vi.fn(async () => resp(503));
    const o = base(f);
    expect(await callJev(o)).toEqual({ ok: false, error: "network" });
    expect(f).toHaveBeenCalledTimes(3);
    const waits = o.sleep.mock.calls.map((c) => c[0] as number);
    expect(waits).toHaveLength(2);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
  });
  it("persistent 429 -> rate_limited", async () => {
    expect(await callJev(base(vi.fn(async () => resp(429))))).toEqual({ ok: false, error: "rate_limited" });
  });
  it("401 -> no_key, no retry", async () => {
    const f = vi.fn(async () => resp(401));
    expect(await callJev(base(f))).toEqual({ ok: false, error: "no_key" });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it.each([400, 402, 403, 404, 422])("%i -> bad_response, no retry", async (s) => {
    const f = vi.fn(async () => resp(s));
    expect(await callJev(base(f))).toEqual({ ok: false, error: "bad_response" });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("invalid json -> bad_response", async () => {
    expect(await callJev(base(vi.fn(async () => resp(200, "not json"))))).toEqual({ ok: false, error: "bad_response" });
  });
  it("network exception -> network, error never leaks key", async () => {
    const f = vi.fn(async () => { throw new TypeError(`failed ${SECRET}`); });
    const r = await callJev(base(f));
    expect(r).toEqual({ ok: false, error: "network" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(f).toHaveBeenCalledTimes(3);
  });
});
