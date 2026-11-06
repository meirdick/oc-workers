// Markdown per-kill table from $RAW/loss50.json (written by loss50.mjs). usage: node table.mjs [RAW]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RAW } from "../loss-lib.mjs";

const r = JSON.parse(readFileSync(join(process.argv[2] ?? RAW, "loss50.json"), "utf8"));
const s = (ms) => (ms === null || ms === undefined ? "–" : (ms / 1000).toFixed(1));
console.log(
  "| # | writer | up s | plan | kill→running s | SQLite rows lost (min) | SQLite window s | non-managed window s | creds window s | creds files missing / changed | relink | workspace window s | checkpoints in period | replayed rows | TG sent / 0 replies / 2+ replies |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const k of r.kills)
  console.log(
    `| ${k.i} | ${k.writer === false ? "**off**" : "on"} | ${s(k.upMs)} | ${k.plan} | ${s(k.runMs)} | ${k.rows ?? "–"} | ${s(k.sqlMs)} | ${s(k.nmMs)} | ${s(k.credsMs)} | ${k.credsMissing} / ${k.credsChanged ?? "–"} | ${k.relink ? "**yes**" : "no"} | ${s(k.wsMs)} | ${k.ckpts} | ${k.replayed} | ${k.tg?.sent ?? "–"} / ${k.tg?.zero ?? "–"} / ${k.tg?.twice ?? "–"} |`,
  );
