// Renders static/icons/*.svg to PNG (16 from icon-16.svg, the rest from icon.svg).
// Requires rsvg-convert. The PNGs are committed; edit only the SVGs.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "static", "icons");
const jobs = [
  [16, "icon-16.svg"],
  [32, "icon.svg"],
  [48, "icon.svg"],
  [128, "icon.svg"],
];

for (const [size, src] of jobs) {
  const out = join(dir, `icon-${size}.png`);
  const r = spawnSync(
    "rsvg-convert",
    ["-w", String(size), "-h", String(size), "-o", out, join(dir, src)],
    { stdio: "inherit" },
  );
  if (r.error || r.status !== 0) {
    console.error("rsvg-convert failed (is librsvg installed?)");
    process.exit(1);
  }
  console.log(`icon-${size}.png`);
}
