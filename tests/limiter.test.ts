import { describe, expect, it } from "vitest";
import { LimiterFullError, createLimiter } from "../src/background/limiter";

function deferred() { let res!: () => void; const p = new Promise<void>((r) => (res = r)); return { p, res }; }

describe("limiter", () => {
  it("rejects when queue full, without running fn", async () => {
    const l = createLimiter({ maxConcurrent: 1, perMinute: 100, maxQueue: 2, now: () => 0, sleep: async () => {} });
    const d = deferred();
    const running = l.run(() => d.p);
    const q1 = l.run(async () => 1);
    const q2 = l.run(async () => 2);
    let ran = false;
    await expect(l.run(async () => { ran = true; })).rejects.toBeInstanceOf(LimiterFullError);
    expect(ran).toBe(false);
    d.res();
    await running;
    expect(await q1).toBe(1);
    expect(await q2).toBe(2);
  });
  it("limits concurrency", async () => {
    const l = createLimiter({ maxConcurrent: 2, perMinute: 100, maxQueue: 50, now: () => 0, sleep: async () => {} });
    let active = 0, peak = 0;
    const task = async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; };
    await Promise.all(Array.from({ length: 6 }, () => l.run(task)));
    expect(peak).toBe(2);
  });
  it("per-minute window delays excess calls", async () => {
    let t = 0;
    const waits: number[] = [];
    const l = createLimiter({ maxConcurrent: 4, perMinute: 2, maxQueue: 50, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
    const out = await Promise.all([1, 2, 3].map((n) => l.run(async () => n)));
    expect(out).toEqual([1, 2, 3]);
    expect(waits).toEqual([60001]);
  });
});
