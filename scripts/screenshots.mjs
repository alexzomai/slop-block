/* global document, chrome */
// Captures docs/screenshots/*.png: loads the test build (deterministic background stub, no network, no real key)
// into system Chromium (CHROMIUM_PATH or /usr/bin/chromium) with an English UI, on an English feed fixture.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { build } from "./build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "screenshots");
const dist = join(tmpdir(), `slop-block-shots-dist-${process.pid}`);
const fixture = readFileSync(join(root, "scripts", "screenshot-feed.html"), "utf8");
const autofillFixture = readFileSync(join(root, "scripts", "screenshot-autofill.html"), "utf8");
const lang = "en";
const FAKE_KEY = "sk-or-v1-example-not-a-real-key";

mkdirSync(out, { recursive: true });
await build(dist, { testBackground: true });
const executablePath = process.env.CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const userDataDir = mkdtempSync(join(tmpdir(), "slop-block-shots-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  headless: false,
  args: ["--headless=new", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-sandbox", "--disable-gpu", `--lang=${lang}`],
  env: { ...process.env, LANGUAGE: lang, LC_ALL: `${lang}.UTF-8` },
});

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  await context.route("https://www.youtube.com/**", (route) => route.fulfill({ contentType: "text/html", body: fixture }));

  // popup: tags + mode + usage block
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 800 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.evaluate((k) => Promise.all([chrome.storage.sync.clear(), chrome.storage.local.set({ openrouterKey: k })]), FAKE_KEY);
  await popup.reload();
  for (const text of ["productivity tips", "programming tutorials"]) {
    await popup.fill("#text", text);
    await popup.click("#add button");
    await popup.waitForFunction((n) => document.querySelectorAll("#tags li").length >= n, text === "productivity tips" ? 1 : 2);
  }
  await popup.waitForFunction(() => document.getElementById("usage").dataset.state === "ok", null, { timeout: 5000 });

  // feed: Show only matching (allowlist) — matching cards are revealed
  const yt = await context.newPage();
  await yt.setViewportSize({ width: 1280, height: 720 });
  await yt.goto("https://www.youtube.com/");
  await yt.waitForFunction(() => document.querySelectorAll("[data-slop-show]").length === 5, null, { timeout: 8000 });
  await yt.waitForTimeout(800); // let the reveal animation finish
  await yt.screenshot({ path: join(out, "feed.png") });
  await yt.close();

  await popup.screenshot({ path: join(out, "popup.png"), fullPage: true });
  await popup.close();

  // feed autofill: few matches, so autofill loads portions, gives up after 5 empty ones and shows its message
  await context.unroute("https://www.youtube.com/**");
  await context.route("https://www.youtube.com/**", (route) => route.fulfill({ contentType: "text/html", body: autofillFixture }));
  const af = await context.newPage();
  await af.setViewportSize({ width: 1280, height: 720 });
  await af.goto("https://www.youtube.com/");
  await af.waitForFunction(() => {
    const s = document.getElementById("slop-feed-status");
    return !!s && !s.hidden && s.textContent.startsWith("No more matching");
  }, null, { timeout: 40000 });
  await af.waitForTimeout(800);
  await af.screenshot({ path: join(out, "feed-autofill.png") });
  await af.close();

  // options: placeholder key is stored locally; the page shows only a status, never the key
  const opt = await context.newPage();
  await opt.setViewportSize({ width: 720, height: 560 });
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.evaluate((k) => chrome.storage.local.set({ openrouterKey: k }), FAKE_KEY);
  await opt.reload();
  await opt.waitForTimeout(500);
  await opt.screenshot({ path: join(out, "options.png"), fullPage: true });
  console.log("screenshots ->", out);
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(dist, { recursive: true, force: true });
}
