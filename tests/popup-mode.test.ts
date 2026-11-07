import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setI18nSource } from "../src/shared/i18n";
import { getMessageFor, type Lang } from "./helpers/messages";
import { PopupController } from "../src/popup/controller";
import { modeTexts } from "../src/popup/texts";
import type { Settings } from "../src/shared/settings";

const S0: Settings = { enabled: true, tags: [], mode: "allowlist", skipSubscriptions: true, filterSearch: false, feedTarget: 12 };

describe("PopupController: режим и подписки", () => {
  it("setMode / setSkipSubscriptions сохраняются и рендерятся", async () => {
    const saved: Settings[] = [];
    const c = new PopupController({ save: async (s) => void saved.push(s), render: () => {} }, S0);
    expect(await c.setMode("blocklist")).toBe(true);
    expect(await c.setSkipSubscriptions(false)).toBe(true);
    expect(c.state.mode).toBe("blocklist");
    expect(c.state.skipSubscriptions).toBe(false);
    expect(saved).toHaveLength(2);
  });
  it("отказ записи → откат к storage и сообщение", async () => {
    const renders: [Settings, string][] = [];
    const c = new PopupController({ save: async () => { throw new Error("quota"); }, render: (s, m) => void renders.push([s, m]) }, S0);
    expect(await c.setMode("blocklist")).toBe(false);
    expect(c.state.mode).toBe("allowlist");
    expect(renders.at(-1)![0].mode).toBe("allowlist");
    expect(renders.at(-1)![1]).not.toBe("");
  });
});

const useLang = (lang: Lang): void => setI18nSource({ getMessage: getMessageFor(lang), getUILanguage: () => lang });
afterEach(() => setI18nSource(undefined));

describe("modeTexts (en)", () => {
  it("allowlist и blocklist", () => {
    useLang("en");
    expect(modeTexts("allowlist").placeholder).toBe("What to show: productivity, IT, neural networks");
    expect(modeTexts("blocklist").placeholder).toBe("What to hide: weight-loss clickbait");
    expect(modeTexts("blocklist").label).toBe("Tag to hide");
  });
});

describe("modeTexts", () => {
  beforeEach(() => useLang("ru"));
  it("allowlist: показывать", () => {
    const t = modeTexts("allowlist");
    expect(t.placeholder).toBe("Что показывать: продуктивность, IT, нейросети");
    expect(t.title).toMatch(/показ/i);
  });
  it("blocklist: скрывать", () => {
    const t = modeTexts("blocklist");
    expect(t.placeholder).toMatch(/^Что скрывать:/);
    expect(t.title).toMatch(/скрыв/i);
  });
});
