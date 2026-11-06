// Results writer: results/<date>/<test>.json (committed) + results/<date>/logs/<test>/ (git-ignored)
// + results/<date>/summary.md (rebuilt from every json of the date after each test).
import fs from "node:fs";
import path from "node:path";
import { TEST_DIR } from "./env.mjs";

export const today = (d = new Date()) => d.toISOString().slice(0, 10);

export function resultsDir(date = today(), root = path.join(TEST_DIR, "results")) {
  const d = path.join(root, date);
  fs.mkdirSync(path.join(d, "logs"), { recursive: true });
  return d;
}

/** Status of a finished test from its checks. */
export function statusOf(r) {
  if (r.error) return "error";
  if (r.blocked) return "blocked";
  if (!r.checks.length) return "fail";
  return r.checks.every((c) => c.ok) ? "pass" : "fail";
}

export function writeResult(dir, r) {
  const out = { ...r, status: statusOf(r) };
  fs.writeFileSync(path.join(dir, `${r.name}.json`), `${JSON.stringify(out, null, 1)}\n`);
  writeSummary(dir);
  return out;
}

export function logDir(dir, name) {
  const d = path.join(dir, "logs", name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const cell = (s) =>
  String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");

export function summaryMd(results, date) {
  const n = (s) => results.filter((r) => r.status === s).length;
  const lines = [
    `# M1 harness results ${date}`,
    "",
    `Pass ${n("pass")}, fail ${n("fail")}, blocked ${n("blocked")}, error ${n("error")} of ${results.length}. Written by \`image/test/run.mjs\`; one JSON per test beside this file.`,
    "",
    "| Test | Status | Image | Checks | Measured | Note |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of results.sort((a, b) => a.name.localeCompare(b.name))) {
    const failed = (r.checks || []).filter((c) => !c.ok).map((c) => c.label);
    const checks = `${(r.checks || []).filter((c) => c.ok).length}/${(r.checks || []).length}${failed.length ? ` (failed: ${failed.join("; ")})` : ""}`;
    const meas = Object.entries(r.measured || {})
      .slice(0, 6)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(", ");
    lines.push(
      `| ${cell(r.name)} | ${r.status} | ${cell((r.image || "").slice(0, 19))} | ${cell(checks)} | ${cell(meas)} | ${cell(r.blocked || r.error || "")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function writeSummary(dir) {
  const rs = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  fs.writeFileSync(path.join(dir, "summary.md"), summaryMd(rs, path.basename(dir)));
}
