// Ring collector for the M4 loss drills: pulls /ops/events (cap 500) every 2 s and appends new rows by id to
// $RING (default worker/test/results/raw/M4-loss/ring.jsonl); /ops/status every 10 s to status.jsonl beside it.
// A gap row {gap:[last, first]} marks lost ids. usage: node loss-collect.mjs   (env U, T, RAW|RING)
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RING, T, U } from "./loss-lib.mjs";

const STATUS = join(dirname(RING), "status.jsonl");
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
    // A wiped Control DO (drill L) restarts its ring at id 1: mark it and follow the new ids.
    const top = ev.length ? ev.at(-1).id : 0;
    if (last && top && top < last) {
      appendFileSync(RING, `${JSON.stringify({ id: last + 0.5, gap: [last, 0], reset: Date.now() })}\n`);
      last = 0;
    }
    const fresh = ev.filter((e) => e.id > last);
    if (fresh.length && last && fresh[0].id !== last + 1)
      appendFileSync(RING, `${JSON.stringify({ id: fresh[0].id - 0.5, gap: [last, fresh[0].id] })}\n`);
    for (const e of fresh) appendFileSync(RING, `${JSON.stringify(e)}\n`);
    if (fresh.length) last = fresh.at(-1).id;
    if (n % 5 === 0) {
      const s = await (
        await fetch(`${U}/ops/status`, { headers: h, signal: AbortSignal.timeout(20_000) })
      ).json();
      appendFileSync(
        STATUS,
        `${JSON.stringify({ t: Date.now(), state: s.state, gen: s.gen?.gen, plan: s.gen?.planKind, ladder: s.ladder?.level, inbox: s.inbox, blockers: s.blockers, ops: s.rt?.ops })}\n`,
      );
    }
  } catch (e) {
    appendFileSync(`${RING}.err`, `${Date.now()} ${e}\n`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
