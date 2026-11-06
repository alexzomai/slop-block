import { describe, expect, it, vi } from "vitest";
import { registerListener } from "../src/background/listener";

function setup(h = { decide: vi.fn(async () => ({ ok: true })), usage: vi.fn(async () => ({ ok: false as const, error: "no_key" as const, local: { requestsToday: 0, requestsTotal: 0, tokensToday: 0, tokensTotal: 0 } })) }) {
  let cb!: (m: unknown, s: { id?: string }, r: (x: unknown) => void) => boolean | void;
  registerListener({ addListener: (f) => { cb = f; } }, "me", h);
  return { h, send: (m: unknown, id: string | null = "me") => { const r = vi.fn(); const ret = cb(m, id === null ? {} : { id }, r); return { ret, r }; } };
}

describe("listener", () => {
  it("slop/usage от себя → ответ асинхронно", async () => {
    const { send, h } = setup();
    const { ret, r } = send({ type: "slop/usage" });
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(r).toHaveBeenCalled());
    expect(h.usage).toHaveBeenCalledOnce();
  });
  it.each([["чужой id", "evil"], ["без id", null]])("slop/usage: %s игнорируется", (_n, id) => {
    const { send, h } = setup();
    const { ret, r } = send({ type: "slop/usage" }, id);
    expect(ret).toBe(false);
    expect(r).not.toHaveBeenCalled();
    expect(h.usage).not.toHaveBeenCalled();
  });
  it("slop/decide чужой — игнорируется; прочие типы и мусор — тоже", () => {
    const { send, h } = setup();
    expect(send({ type: "slop/decide" }, "evil").ret).toBe(false);
    expect(send({ type: "other" }).ret).toBe(false);
    expect(send(null).ret).toBe(false);
    expect(h.decide).not.toHaveBeenCalled();
  });
  it("сбой сервиса → фиксированный код, без текста", async () => {
    const { send } = setup({ decide: vi.fn(async () => { throw new Error("SECRETTEXT"); }), usage: vi.fn(async () => { throw new Error("SECRETTEXT"); }) } as any);
    const u = send({ type: "slop/usage" });
    await vi.waitFor(() => expect(u.r).toHaveBeenCalled());
    expect(JSON.stringify(u.r.mock.calls[0])).not.toContain("SECRETTEXT");
    expect(u.r.mock.calls[0]![0]).toMatchObject({ ok: false, error: "network" });
    const d = send({ type: "slop/decide" });
    await vi.waitFor(() => expect(d.r).toHaveBeenCalledWith({ ok: false, error: "network" }));
  });
});
