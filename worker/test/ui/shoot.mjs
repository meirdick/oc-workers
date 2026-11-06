// Owner console screenshots: login, every tab, keyboard focus × 390 and 1280 wide × light and dark.
// Every tab in the backoff state (alerts, retry); Overview also asleep and running; Setup running (pairing, Raise).
// Needs the fixture under wrangler dev (see wrangler.jsonc here) and playwright-core with a Chromium:
//   PW_DIR=/tmp/pw CHROME=/path/to/chrome node worker/test/ui/shoot.mjs [http://localhost:8799]
// Writes worker/test/results/ui/v2/<state>-<tab>-<width>-<scheme>.png. Local only.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(join(process.env.PW_DIR ?? process.cwd(), "x.js"))("playwright-core");
const base = process.argv[2] ?? "http://localhost:8799";
const out = join(dirname(fileURLToPath(import.meta.url)), "../results/ui/v2");
mkdirSync(out, { recursive: true });

const TABS = ["overview", "log", "setup"];
const SHOTS = [
  ...TABS.map((t) => ["backoff", t]),
  ["asleep", "overview"],
  ["running", "overview"],
  ["running", "setup"],
];

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
for (const scheme of ["light", "dark"]) {
  for (const width of [390, 1280]) {
    const ctx = await browser.newContext({
      viewport: { width, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/`);
    await page.screenshot({ path: join(out, `login-${width}-${scheme}.png`) });
    await page.fill("#t", "fixture-owner-token");
    await page.click("button[type=submit]");
    await page.waitForURL(`${base}/`);
    for (const [fx, tab] of SHOTS) {
      await page.goto(`${base}/_fx/${fx}`);
      await page.goto(`${base}/?tab=${tab}`);
      await page.screenshot({ path: join(out, `${fx}-${tab}-${width}-${scheme}.png`), fullPage: true });
    }
    // Keyboard focus: the state button, then the active tab.
    await page.goto(`${base}/_fx/running`);
    await page.focus("button[name=act]");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.screenshot({ path: join(out, `focus-${width}-${scheme}.png`) });
    await ctx.close();
  }
}
await browser.close();
console.log(`wrote ${out}`);
