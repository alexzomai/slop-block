// Запускает оба набора e2e по очереди (память ограничена — не параллельно). Код возврата ≠ 0, если упал любой.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = join(dirname(fileURLToPath(import.meta.url)), "run.mjs");
let code = 0;
for (const [suite, lang] of [["openrouter", "ru"], ["typesafe", "ru"], ["typesafe", "en"], ["tags", "ru"], ["i18n", "ru"], ["i18n", "en"]]) {
  const r = spawnSync(process.execPath, [run, `--suite=${suite}`, `--lang=${lang}`], { stdio: "inherit", cwd: resolve(dirname(run), "..") });
  if (r.status !== 0) code = r.status ?? 1;
}
process.exit(code);
