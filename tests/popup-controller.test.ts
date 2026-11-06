import { describe, expect, it } from "vitest";
import { PopupController } from "../src/popup/controller";
import type { Settings } from "../src/shared/settings";

const empty: Settings = { enabled: true, tags: [], mode: "allowlist", skipSubscriptions: true, feedTarget: 12 };

function setup(failWhen: (s: Settings) => boolean = () => false) {
  let stored: Settings = empty; // «storage»
  const renders: Array<{ s: Settings; msg: string }> = [];
  const c = new PopupController(
    {
      save: async (s) => { if (failWhen(s)) throw new Error("quota"); stored = s; },
      render: (s, msg) => renders.push({ s, msg }),
    },
    empty,
  );
  return { c, renders, storage: () => stored };
}

describe("PopupController: UI равен storage", () => {
  it("успешная запись: состояние и рендер обновляются", async () => {
    const { c, renders, storage } = setup();
    expect(await c.add("кликбейт")).toBe(true);
    expect(storage().tags).toHaveLength(1);
    expect(renders.at(-1)!.s).toEqual(storage());
    expect(renders.at(-1)!.msg).toBe("");
  });

  it("запись падает: откат, сообщение, UI == storage (переключатель, добавление, удаление)", async () => {
    const { c, renders, storage } = setup((s) => s.tags.length >= 2 || !s.enabled);
    await c.add("a");
    await c.add("b"); // падает
    expect(c.state).toEqual(storage());
    expect(renders.at(-1)).toEqual({ s: storage(), msg: "save" });
    expect(storage().tags).toHaveLength(1);
    expect(await c.setEnabled(false)).toBe(false); // падает
    expect(renders.at(-1)!.s.enabled).toBe(true);
    expect(storage().enabled).toBe(true);
    expect(c.state).toEqual(storage());
  });

  it("ошибка валидации не пишет в storage и не меняет состояние", async () => {
    const { c, renders, storage } = setup();
    expect(await c.add("   ")).toBe(false);
    expect(storage()).toEqual(empty);
    expect(renders.at(-1)!.msg).toBe("empty");
  });

  it("параллельные операции выполняются по очереди", async () => {
    const { c, storage } = setup();
    await Promise.all([c.add("a"), c.add("b"), c.add("c")]);
    expect(storage().tags.map((t) => t.text)).toEqual(["a", "b", "c"]);
    expect(c.state).toEqual(storage());
  });
});
