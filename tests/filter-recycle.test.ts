import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHider, createRevealer } from "../src/content/dom";
import { FeedFilter } from "../src/content/filter";
import type { DecideResponse } from "../src/shared/decision";
import type { Mode, Settings } from "../src/shared/settings";

// Узел, который страница убирает из DOM и позже вставляет снова уже с другим видео (переиспользование YouTube).
interface Node { id: string; connected: boolean; hiddenFx: boolean; shownFx: boolean }
const S = (mode: Mode, enabled = true): Settings => ({ enabled, tags: [{ id: "t0", text: "IT", enabled: true }], mode, skipSubscriptions: false, filterSearch: false, compatUbol: false, feedTarget: 12 });
const match = (m: boolean): DecideResponse => ({ ok: true, hide: m, matchedTagIds: m ? ["t0"] : [], probabilities: {} });

function setup(mode: Mode, answers: Record<string, boolean>) {
  const nodes: Node[] = [];
  const hider = createHider<Node>({ hide: (n) => void (n.hiddenFx = true), show: (n) => void (n.hiddenFx = false) });
  const revealer = createRevealer<Node>({ reveal: (n) => void (n.shownFx = true), hide: (n) => void (n.shownFx = false) });
  const f = new FeedFilter<Node>({
    findCards: () => nodes.filter((n) => n.connected),
    extract: (n) => ({ videoId: n.id, title: "t", channel: "c" }),
    hide: (n) => hider.hide(n),
    show: (n) => hider.show(n),
    allow: (n) => revealer.allow(n),
    disallow: (n) => revealer.disallow(n),
    send: async (r) => match(answers[r.video.videoId] ?? false),
  }, S(mode));
  return { f, nodes };
}
const flush = () => vi.advanceTimersByTimeAsync(700);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("переиспользование узла с другим videoId (ревью r2)", () => {
  it("blocklist: скрытый A, узел убран и возвращён как B (hide=false) → B виден, выключение фильтра ничего не оставляет", async () => {
    const { f, nodes } = setup("blocklist", { A: true, B: false });
    const n: Node = { id: "A", connected: true, hiddenFx: false, shownFx: false };
    nodes.push(n);
    f.schedule(); await flush();
    expect(n.hiddenFx).toBe(true);
    n.connected = false;
    f.scan(false);
    expect(n.hiddenFx).toBe(false); // выбыл из учёта — эффект снят
    n.id = "B"; n.connected = true;
    f.schedule(); await flush();
    expect(n.hiddenFx).toBe(false);
    f.reconfigure(S("blocklist", false), { onSubscriptions: false });
    expect(n.hiddenFx).toBe(false);
  });
  it("blocklist: отложенное скрытие не применяется к узлу, выбывшему до flush", async () => {
    const { f, nodes } = setup("blocklist", { A: true, B: false });
    const n: Node = { id: "A", connected: true, hiddenFx: false, shownFx: false };
    nodes.push(n);
    f.schedule();
    await vi.advanceTimersByTimeAsync(310); // ответ получен, скрытие ждёт пачки
    n.connected = false;
    f.scan(false);
    n.id = "B"; n.connected = true;
    await flush();
    f.schedule(); await flush();
    expect(n.hiddenFx).toBe(false);
  });
  it("allowlist: показанный A, узел убран и возвращён как B (не подходит) → B скрыт шлюзом (эффект проявления снят)", async () => {
    const { f, nodes } = setup("allowlist", { A: true, B: false });
    const n: Node = { id: "A", connected: true, hiddenFx: false, shownFx: false };
    nodes.push(n);
    f.schedule(); await flush();
    expect(n.shownFx).toBe(true);
    n.connected = false;
    f.scan(false);
    expect(n.shownFx).toBe(false);
    n.id = "B"; n.connected = true;
    f.schedule(); await flush();
    expect(n.shownFx).toBe(false);
    expect(f.snapshot().visible).toBe(0);
  });
  it("allowlist: отложенное проявление не применяется к узлу, выбывшему до flush", async () => {
    const { f, nodes } = setup("allowlist", { A: true, B: false });
    const n: Node = { id: "A", connected: true, hiddenFx: false, shownFx: false };
    nodes.push(n);
    f.schedule();
    await vi.advanceTimersByTimeAsync(305);
    n.connected = false;
    f.scan(false);
    n.id = "B"; n.connected = true;
    await flush();
    f.schedule(); await flush();
    expect(n.shownFx).toBe(false);
  });
});

describe("смена видео внутри подключённого узла (ревью r3)", () => {
  for (const mode of ["blocklist", "allowlist"] as const) {
    it(`${mode}: A→B в том же подключённом узле — эффект A снимается, B оценивается и запрашивается`, async () => {
      const { f, nodes } = setup(mode, { A: true, B: false });
      const n: Node = { id: "A", connected: true, hiddenFx: false, shownFx: false };
      nodes.push(n);
      f.schedule(); await flush();
      expect(mode === "blocklist" ? n.hiddenFx : n.shownFx).toBe(true);
      n.id = "B"; // узел остаётся в DOM
      f.schedule(); await flush();
      expect(n.hiddenFx).toBe(false);
      expect(n.shownFx).toBe(false);
    });
  }
});
