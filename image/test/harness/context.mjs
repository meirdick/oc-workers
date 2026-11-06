// Test context `t` given to each test's run(t). Collects checks, measured values and notes; tracks boxes.
import fs from "node:fs";
import path from "node:path";
import { Box } from "./box.mjs";
import { CTL, ctl, PFX } from "./env.mjs";

export function makeContext({ name, image, images = {}, features = {}, logDir }) {
  const boxes = [];
  const t = {
    name,
    image,
    images,
    features,
    logDir,
    checks: [],
    measured: {},
    notes: [],
    blocked: null,
    seq0: 0,
    track: (b) => boxes.push(b),
    boxes,
    /** New box. name is prefixed with ocm1n<N>-<test>- (per-network run). */
    box(o = {}) {
      return new Box(t, { image, ...o, name: `${PFX}-${name}-${o.name || boxes.length + 1}`.slice(0, 63) });
    },
    check(label, ok, measured) {
      // JSON-safe copy: a measured value with a Box (circular) must not crash the result write.
      try {
        if (measured !== undefined) JSON.stringify(measured);
      } catch {
        measured = String(measured);
      }
      const c = { label, ok: !!ok, ...(measured !== undefined ? { measured } : {}) };
      t.checks.push(c);
      t.note(
        `${c.ok ? "PASS" : "FAIL"} ${label}${measured !== undefined ? ` (${JSON.stringify(measured)})` : ""}`,
      );
      return c.ok;
    },
    measure(k, v) {
      t.measured[k] = v;
    },
    note(s) {
      const line = `${new Date().toISOString()} ${s}`;
      t.notes.push(line);
      if (process.env.OCM1_VERBOSE !== "0") console.log(`  [${name}] ${s}`);
    },
    /** Mark the test blocked (a module it needs is missing). Returns false so a test can `return t.block()`. */
    block(why) {
      t.blocked = why;
      t.note(`BLOCKED ${why}`);
      return false;
    },
    need(feature, why) {
      if (features[feature]) return true;
      return t.block(why || `image lacks ${feature}`);
    },
    ctl,
    faults: (f) => ctl("/_ctl/faults", f),
    async records(q = {}) {
      const u = new URLSearchParams({
        since: String(q.since ?? t.seq0),
        ...(q.plane ? { plane: q.plane } : {}),
        ...(q.route ? { route: q.route } : {}),
      });
      return ctl(`/_ctl/records?${u}`);
    },
    gateState: () => ctl("/_ctl/state"),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    save(file, text) {
      fs.writeFileSync(
        path.join(logDir, file),
        typeof text === "string" ? text : JSON.stringify(text, null, 1),
      );
    },
    get CTL() {
      return CTL;
    },
  };
  return t;
}
