// Fault hooks kept from M0 (image/README.md "Faults"). Lines in /var/lib/ocrt/faults are read every
// 1 s and the file is renamed to faults.<ts>.done. `ocsupctl fault <line>` does the same (test only).
import fs from "node:fs";

export const FAULT_CMDS = [
  "kill-gateway",
  "kill-litestream",
  "balloon-vm",
  "balloon-gw",
  "balloon-stop",
  "exit",
  "hang-sigterm",
  "heartbeat-off",
  "heartbeat-on",
  "gate-drop", // new in M1: heartbeat sends fail as if the gate were gone (fence test)
  "gate-ok",
  "heap", // M1 test: `heap <usedPct>` feeds memwatch a gateway heap figure; `heap off` ends it
];

export function parseFaults(text) {
  const out = [];
  for (const l of String(text).split("\n")) {
    const t = l.trim();
    if (!t || t.startsWith("#")) continue;
    const [cmd, arg] = t.split(/\s+/);
    out.push({ cmd, arg: arg ?? null, known: FAULT_CMDS.includes(cmd) });
  }
  return out;
}

/** Read and consume the fault file. Returns parsed lines ([] when absent). */
export function takeFaults(file, now = Date.now) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
    fs.renameSync(file, `${file}.${now()}.done`);
  } catch {
    return [];
  }
  return parseFaults(text);
}

/** Apply one fault through handlers {cmd: (arg) -> extra}. Returns the record. */
export function applyFault(f, handlers) {
  const rec = { cmd: f.cmd, arg: f.arg };
  const h = handlers[f.cmd];
  if (!f.known || !h) return { ...rec, err: "unknown" };
  try {
    return { ...rec, ...(h(f.arg) || {}) };
  } catch (e) {
    return { ...rec, err: e.code || String(e) };
  }
}
