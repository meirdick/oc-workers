// Stage the assets folder for the oc-host Worker: the docs build (dist) goes under /docs.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const out = join(root, ".deploy");

if (!existsSync(join(dist, "index.html"))) {
  console.error("Failed: dist is missing. Run npm run build first.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
cpSync(dist, join(out, "docs"), { recursive: true });
// The landing page is the site root.
cpSync(join(root, "landing", "index.html"), join(out, "index.html"));

// Workers reads only the root _headers file, so move it up and prefix its paths.
const docsHeaders = join(out, "docs", "_headers");
if (existsSync(docsHeaders)) {
  const text = readFileSync(docsHeaders, "utf8").replace(/^\/_astro\/\*/m, "/docs/_astro/*");
  rmSync(docsHeaders);
  writeFileSync(join(out, "_headers"), text);
}

console.log("Staged .deploy: landing at /, docs at /docs/");
