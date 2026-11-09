// Замер скорости фильтрации (не часть `npm run e2e`): боевой background (dist/), fetch в service worker
// подменён моком с задержкой 800–1500 мс (детерминированный разброс). Печатает JSON-таблицу метрик.
// Запуск: node e2e/perf.mjs [--out=файл.json]
/* global performance, MutationObserver, innerHeight, scrollTo, window, Element, setTimeout */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { build } from "../scripts/build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const out = (process.argv.find((a) => a.startsWith("--out=")) ?? "").slice(6);
const CARDS = 36;
const SECRET = "sk-or-v1-perf-secret-0000000000";

// 36 карточек, каждая вторая подходит под тег «good» (id vid01…vid36)
const htmlFor = (pfx) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>perf</title>
<style>body{margin:8px;font-family:sans-serif}#contents{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
ytd-rich-item-renderer{display:block;border:1px solid #888;height:240px;box-sizing:border-box;padding:6px}</style></head><body><div id="contents"></div>
<script>
const c = document.getElementById("contents");
for (let n = 1; n <= ${CARDS}; n++) {
  const el = document.createElement("ytd-rich-item-renderer");
  const id = "v${pfx}" + String(n).padStart(2, "0") + "xxxxxx";
  el.id = id;
  el.innerHTML = '<a href="/watch?v=' + id + '"><span id="video-title"></span></a><ytd-channel-name><a>Канал</a></ytd-channel-name>';
  el.querySelector("#video-title").textContent = (n % 2 === 1 ? "good " : "bad ") + "видео " + n;
  c.append(el);
}
</script></body></html>`;

// отметки проявления карточек (в странице): время от начала загрузки, порядок, положение карточки
const initScript = () => {
  window.__reveals = [];
  const seen = new Set();
  new MutationObserver((ms) => {
    for (const m of ms) {
      const el = m.target;
      if (!(el instanceof Element) || !el.hasAttribute("data-slop-show") || seen.has(el.id)) continue;
      seen.add(el.id);
      window.__reveals.push({ id: el.id, t: Math.round(performance.now()) });
    }
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-slop-show"] });
};

const swMock = (secret) => {
  globalThis.__fetches = [];
  const first = !globalThis.__installed;
  globalThis.__installed = true;
  globalThis.__msgs = [];
  globalThis.__active = 0;
  globalThis.__maxActive = 0;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  if (first) chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === "slop/decide") globalThis.__msgs.push({ t: Date.now(), id: m.video.videoId });
    return undefined;
  });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const started = Date.now();
    globalThis.__fetches.push({ t: started, title: body.state.title });
    globalThis.__maxActive = Math.max(globalThis.__maxActive, ++globalThis.__active);
    await new Promise((r) => setTimeout(r, 800 + Math.floor(rnd() * 700)));
    globalThis.__active--;
    const p = body.state.title.startsWith("good") ? 0.9 : 0.1;
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: p }])), usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
  };
  return chrome.storage.local.set({ openrouterKey: secret });
};

await build(dist, { testBackground: false });
const executablePath = process.env.CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "slop-perf-")), {
  executablePath,
  headless: false,
  args: ["--headless=new", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-sandbox", "--disable-gpu", "--lang=ru"],
});
const rows = [];
let lastPaid = 0; // лимитер background: 60 вызовов в скользящую минуту — между платными сценариями ждём, чтобы замер не упирался в окно
try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  let pfx = "a";
  await context.route("https://www.youtube.com/**", (route) => route.fulfill({ contentType: "text/html", body: htmlFor(pfx) }));
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${extId}/popup.html`);
  await setup.evaluate(async () => {
    await chrome.storage.sync.clear();
    await chrome.storage.sync.set({ "slop.settings": { enabled: true, order: ["g"], mode: "allowlist", feedTarget: 12 }, "slop.tag.g": { text: "good", enabled: true } });
    await chrome.storage.local.remove(Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("dc3:")));
  });
  await setup.close();

  for (const width of [390, 1280]) {
    // cold — пустой кэш; warm — повторный визит (всё в кэше); scroll — холодный кэш, пользователь сразу прокручивает вниз
    for (const scenario of ["cold", "warm", "scroll"]) {
      if (scenario !== "warm") pfx = `${width}${scenario[0]}`.slice(-4);
      if (scenario !== "warm") {
        await new Promise((r) => setTimeout(r, Math.max(0, lastPaid + 61000 - Date.now())));
        lastPaid = Date.now();
      }
      await sw.evaluate(swMock, SECRET);
      // кэш-хиты в памяти SW: для warm переиспользуем тот же SW, кэш уже лежит в storage
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript(initScript);
      const t0 = Date.now();
      await page.goto("https://www.youtube.com/");
      if (scenario === "scroll") {
        await page.waitForTimeout(300);
        await page.evaluate(() => scrollTo(0, 99999)); // сразу в конец: видимы последние карточки
      }
      const wantGood = CARDS / 2;
      await page
        .waitForFunction((n) => document.querySelectorAll("[data-slop-show]").length >= n, wantGood, { timeout: 90000 })
        .catch(() => {});
      await page.waitForTimeout(400);
      const info = await page.evaluate(() => {
        const vh = innerHeight;
        const inView = (id) => {
          const r = document.getElementById(id).getBoundingClientRect();
          return r.bottom > 0 && r.top < vh;
        };
        return { reveals: window.__reveals, shown: document.querySelectorAll("[data-slop-show]").length, inView: window.__reveals.map((r) => inView(r.id)) , vh};
      });
      const fetches = await sw.evaluate(() => ({ n: globalThis.__fetches.length, max: globalThis.__maxActive, msgs: globalThis.__msgs.length, ts: globalThis.__fetches.map((f) => f.t), mts: globalThis.__msgs.map((m) => m.t) }));
      const times = info.reveals.map((r) => r.t);
      // «видимые в окне подходящие» после сдвига (для scroll) и все подходящие, что в окне в конце
      const viewGood = await page.evaluate(() => {
        const vh = innerHeight;
        return [...document.querySelectorAll("ytd-rich-item-renderer")].filter((e) => { const r = e.getBoundingClientRect(); return e.hasAttribute("data-slop-show") && r.bottom > 0 && r.top < vh; }).map((e) => e.id);
      });
      const viewTimes = info.reveals.filter((r) => viewGood.includes(r.id)).map((r) => r.t);
      rows.push({
        width, scenario,
        first_ms: times[0] ?? null,
        n12_ms: times[11] ?? null,
        all_ms: times[wantGood - 1] ?? null,
        shown: info.shown,
        view_shown: viewGood.length,
        view_last_ms: viewTimes.length ? Math.max(...viewTimes) : null,
        fetches: fetches.n,
        maxActive: fetches.max,
        messages: fetches.msgs,
        order: info.reveals.slice(0, 12).map((r) => Number(r.id.slice(-8, -6))).join(","),
        wall_ms: Date.now() - t0,
      });
      await page.close();
    }
  }
} finally {
  await context.close();
}
console.table(rows);
if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
