# AGENTS.md

Brief for AI coding agents working on **slop-block**.

## What this is

A Chrome (Manifest V3) extension for YouTube. It filters the feed by user-written "smart tags". The hide/show decision comes from **TypeSafe Jev** (a System One decision model, `typesafe/jev-1.13`) called through **OpenRouter** (default) or the native **TypeSafe** API (`https://api.typesafe.ai/v1/systemone`) with the **user's own API key** for the selected provider. There is no backend. Two modes: "Show only matching" (allowlist, default) and "Hide matching" (blocklist).

## Layout

- `src/background/` — service worker: Jev client for both providers (`client.ts`, `jev.ts`, provider registry `providers.ts`), single request limiter (`limiter.ts`), deadlines, decision cache keyed by `(videoId, tag)` plus the canonical model version, not the provider (`cache.ts`), spend tracking (`usage.ts`, `stats.ts`), message listener (`listener.ts`), settings/storage. `test-stub.ts` is a deterministic stand-in used only in `dist-test/`.
- `src/content/` — runs on youtube.com: card selectors (`selectors.ts`), DOM reading (`dom.ts`), filter loop (`filter.ts`), allowlist/blocklist gating, subscriptions bypass, marks (`mark.ts`). Styles in `static/gate.css`. Feed autofill: `autofill.ts` (pure controller with cost limits: 5 empty portions in a row, 15 per page visit), `feed.ts` (DOM adapter: continuation re-entry without scrolling, indicator).
- `src/popup/`, `src/options/` — UI (tags, mode, spend block; key/model/threshold). Strings come from `static/_locales/{en,ru}` via `chrome.i18n`.
- `src/shared/` — contracts and helpers shared across contexts. `decision.ts` is the message contract between content and background; `settings.ts` holds tag rules (max 20 tags, 200 chars, `tagIdentity`).
- `static/` — manifest, HTML, CSS, `_locales`. `scripts/` — build and screenshots. `tests/` — vitest. `e2e/` — Playwright against a YouTube fixture. `openspec/` — specs and changes.

## Commands

```
npm ci
npm run typecheck
npm run lint
npm test               # vitest, no browser needed
npm run build          # -> dist/ (load unpacked)
npm run build:test     # -> dist-test/ (with background stub)
npm run e2e            # needs system Chromium
npm run screenshots    # regenerates docs/screenshots/*.png, needs system Chromium
```

e2e and screenshots use `CHROMIUM_PATH` (falls back to `/usr/bin/chromium`). Chrome 120+ is required for the extension itself.

## Invariants — do not break

1. **The API key lives in `chrome.storage.local` with `TRUSTED_CONTEXTS` access level** (not reachable from content scripts or the YouTube page). `background` uses it for requests, `options` saves it, `popup` only checks presence and reduces it to a boolean; the background verifies `sender.id`. Never in content scripts, never in logs, never in responses, never committed.
2. **Page text is read and written only via `textContent`** (no `innerHTML`; enforced by `tests/no-innerhtml.test.ts`). YouTube titles are untrusted input.
3. **Fail-open.** Any error (no key, network, bad response, rate limit) must leave the page usable and never hide content by mistake in blocklist mode. Allowlist gating reveals/keeps per the documented states.
4. **≤1 paid call per (videoId, tag) pair while cached (TTL 30d, capacity 20k, oldest evicted).** Concurrent requests for the same pair share one in-flight call; `tagIdentity` defines tag equality.
5. **One limiter for every `fetch`** to any provider (OpenRouter and TypeSafe; decision and key/usage calls alike).
6. **A deadline on every fetch and on reading the body.**
7. Send the provider (OpenRouter or TypeSafe) only the minimum: title, channel, description snippet. No remote code; permissions stay at `storage` plus host access to youtube.com, openrouter.ai and api.typesafe.ai. Each provider key (`openrouterKey`, `typesafeKey`) obeys invariant 1 and goes only to its own provider.
8. Do not change `src/shared/decision.ts` contract without a spec change.

## Process (OpenSpec)

Note: `openspec/` is kept in the private working repo and may be absent in the public mirror.

Work is driven by `openspec/changes/<name>/` (`proposal.md`, `specs/`, `design.md`, `tasks.md`). Flow: `/opsx:propose` → commit the spec → `/opsx:apply` → checks → review → merge → archive. `design.md` must contain a **Threat model** section (what blocks release vs P3). Do not push or archive without being asked. Keep the working tree free of secrets and local paths; `openspec/` is committed but is excluded when publishing to GitHub.

Before finishing: `npm run typecheck && npm run lint && npm test && npm run build`, plus `npm run e2e` when behavior changes.

## Conventions

- TypeScript, ESM, esbuild IIFE bundles per entry (`background`, `content`, `options`, `popup`); no runtime dependencies.
- UI strings go through `chrome.i18n` (`_locales/en` and `ru` must stay in key parity; tests enforce it).
- Settings live in `chrome.storage.sync` (`slop.settings`, `slop.tag.<id>`); secrets and decision cache live in `chrome.storage.local` (the provider choice and per-provider models are in its `settings`; TypeSafe has no balance API, so its spend block is local counts in `usageStatsTypesafe`).
- Settings fields: `enabled`, `tags`, `mode`, `skipSubscriptions`, `feedTarget` (6–30, default 12). Defaults: mode `allowlist`, "Don't filter subscriptions" on, model `typesafe/jev-1.13`, threshold `0.7`.
- Unit tests run in Node without a browser (vitest); `e2e/` is the only browser suite.
- Commit messages are short and in the style of `git log`; one change per branch named after the OpenSpec change.
