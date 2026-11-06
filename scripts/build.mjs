import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { build as esbuild } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const entries = {
  background: "src/background/index.ts",
  content: "src/content/index.ts",
  options: "src/options/index.ts",
  popup: "src/popup/index.ts",
};

/** Собирает расширение в outDir (по умолчанию dist/). Каждая точка входа — отдельный IIFE-бандл. */
export async function build(outDir = join(root, "dist"), { testBackground = false } = {}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await esbuild({
    entryPoints: Object.fromEntries(
      Object.entries({ ...entries, ...(testBackground ? { background: "src/background/test-stub.ts" } : {}) }).map(([k, v]) => [k, join(root, v)]),
    ),
    outdir: outDir,
    bundle: true,
    format: "iife",
    target: "chrome120",
    platform: "browser",
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  });
  await cp(join(root, "static"), outDir, { recursive: true });
  return outDir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--test")) {
    await build(join(root, "dist-test"), { testBackground: true });
    console.log("built -> dist-test/ (с заглушкой background)");
  } else {
    await build();
    console.log("built -> dist/");
  }
}
