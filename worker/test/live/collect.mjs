// Collector for live drills: Control DO ring (cap 500 per read) every 2 s → RAW/ring.jsonl (gap rows when a
// read misses ids), status every 10 s → RAW/status.jsonl. env U, T, RAW. Run in the background.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const U = process.env.U;
const T = process.env.T;
const RAW = process.env.RAW ?? join(dirname(fileURLToPath(import.meta.url)), "../results/raw/M4-sleep");
mkdirSync(RAW, { recursive: true });
const RING = join(RAW, "ring.jsonl");
const STATUS = join(RAW, "status.jsonl");
let last = 0;
if (existsSync(RING)) {
  const l = readFileSync(RING, "utf8").trim().split("\n").filter(Boolean);
  if (l.length) last = Math.floor(JSON.parse(l.at(-1)).id);
}
const h = { authorization: `Bearer ${T}` };
for (let n = 0; ; n++) {
  try {
    const r = await fetch(`${U}/ops/events?limit=500`, { headers: h, signal: AbortSignal.timeout(20_000) });
    const ev = ((await r.json()).events ?? []).reverse();
    const fresh = ev.filter((e) => e.id > last);
    if (fresh.length && last && fresh[0].id !== last + 1)
      appendFileSync(RING, `${JSON.stringify({ id: fresh[0].id - 0.5, gap: [last, fresh[0].id] })}\n`);
    for (const e of fresh) appendFileSync(RING, `${JSON.stringify(e)}\n`);
    if (fresh.length) last = fresh.at(-1).id;
    if (n % 5 === 0) {
      const s = await (
        await fetch(`${U}/ops/status`, { headers: h, signal: AbortSignal.timeout(20_000) })
      ).json();
      const row = { t: Date.now(), state: s.state, gen: s.gen?.gen, plan: s.gen?.planKind, ladder: s.ladder };
      Object.assign(row, {
        inbox: s.inbox,
        wake: s.wake,
        blockers: s.blockers,
        sleep: s.rt?.sleep,
        ops: s.rt?.ops,
      });
      appendFileSync(STATUS, `${JSON.stringify(row)}\n`);
    }
  } catch (e) {
    appendFileSync(join(RAW, "collect.err"), `${Date.now()} ${e}\n`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
