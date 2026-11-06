#!/usr/bin/env node
// M1 local Docker harness runner.
//   node image/test/run.mjs <test...|all> [--no-build] [--image TAG] [--base REF] [--prev-base REF|--prev-image TAG]
//        [--results DIR] [--net N] [--keep] [--list]
//   --base builds the main image FROM REF; --prev-base also builds the pinned release, --prev-image names a
//   built one (env OCM1_UC_PREV; only _upgrade-contract reads it).
//   node image/test/run.mjs --down --net N
// Takes a free run slot N (docker network ocm1n<N>, 15.N.0.0/24, names ocm1n<N>-*; harness/env.mjs
// acquireNet), so runs go in parallel. Builds the image once (docker build image/ -> oc-m1:n<N>, plus
// the 2026.9.36 variant when a test needs it; labels from the base, see baseArgs), brings up the env
// (fakes + SeaweedFS), runs each test in tests/<name>.mjs, writes results/<date>/<name>.json and
// summary.md, then removes the env (not with --keep). Exit 0 when every selected test passed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeContext } from "./harness/context.mjs";
import { dk } from "./harness/docker.mjs";
import { acquireNet, ctl, envDown, envUp, IMAGE_DIR, N, PFX, TEST_DIR } from "./harness/env.mjs";
import { logDir, resultsDir, statusOf, writeResult } from "./harness/results.mjs";
import { DUMP_JS, wiringFeatures } from "./harness/wiring.mjs";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : d;
};
const TESTS_DIR = path.join(TEST_DIR, "tests");
const allTests = () =>
  fs
    .readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".mjs") && !f.startsWith("_"))
    .map((f) => f.slice(0, -4))
    .sort();

if (flag("--list")) {
  for (const n of allTests()) {
    const m = (await import(path.join(TESTS_DIR, `${n}.mjs`))).default;
    console.log(`${n.padEnd(42)} ${m.source || ""}`);
  }
  process.exit(0);
}
if (flag("--down")) {
  if (opt("--net") === undefined) {
    console.error("--down needs --net N (docker network ls | grep ocm1n)");
    process.exit(2);
  }
  envDown(Number(opt("--net")));
  console.log(`env ocm1n${opt("--net")} down`);
  process.exit(0);
}
const positional = args.filter(
  (a, i) =>
    !a.startsWith("--") &&
    !["--image", "--date", "--net", "--base", "--prev-base", "--prev-image", "--results"].includes(
      args[i - 1],
    ),
);
const selected = positional.includes("all") || !positional.length ? allTests() : positional;

const gitSha = spawnSync("git", ["-C", IMAGE_DIR, "rev-parse", "--short=12", "HEAD"], {
  encoding: "utf8",
}).stdout.trim();
const dirty =
  spawnSync("git", ["-C", IMAGE_DIR, "status", "--porcelain", "--", "."], {
    encoding: "utf8",
  }).stdout.trim() !== "";

const DEFAULT_BASE = /^ARG BASE=(\S+)$/m.exec(
  fs.readFileSync(path.join(IMAGE_DIR, "Dockerfile"), "utf8"),
)?.[1];

/**
 * Label build args for a base (M1-STATUS "hdr": labels were hard-coded to 2026.10.9). Version: the
 * base label org.opencontainers.image.version; digest: from a `@sha256:` ref, else the repo digest.
 */
function baseArgs(base = DEFAULT_BASE) {
  if (dk(["image", "inspect", base]).code !== 0) dk(["pull", base], { timeoutMs: 900_000 });
  const cfg = JSON.parse(dk(["image", "inspect", "-f", "{{json .}}", base]).out || "{}");
  const version = cfg.Config?.Labels?.["org.opencontainers.image.version"] || "";
  const digest =
    /@(sha256:[0-9a-f]{64})$/.exec(base)?.[1] ||
    /@(sha256:[0-9a-f]{64})$/.exec((cfg.RepoDigests || [])[0] || "")?.[1] ||
    "";
  if (!version || !digest) throw new Error(`base ${base}: version ${version || "?"} digest ${digest || "?"}`);
  return { OPENCLAW_VERSION: version, BASE_DIGEST: digest };
}

/** Build one image tag. Returns {tag, id, ms}. */
function build(tag, buildArgs = {}) {
  const t0 = Date.now();
  buildArgs = { ...baseArgs(buildArgs.BASE), ...buildArgs };
  const a = ["build", "-q", "-t", tag, "--build-arg", `OCSUP_SHA=${gitSha}${dirty ? "-dirty" : ""}`];
  for (const [k, v] of Object.entries(buildArgs)) a.push("--build-arg", `${k}=${v}`);
  a.push(IMAGE_DIR);
  console.log(`build ${tag} ...`);
  const r = dk(a, { timeoutMs: 1_800_000 });
  if (r.code !== 0) throw new Error(`build ${tag}: ${r.err.slice(-1500)}`);
  return { tag, id: r.out.trim(), ms: Date.now() - t0 };
}

/** What the image holds: M1 modules present or not. */
function features(tag) {
  const r = dk([
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    tag,
    "-c",
    "cd /opt/ocrt && find . -maxdepth 2 -name '*.mjs' -o -maxdepth 2 -type f -name 'ocsupctl*' | sort; for b in litestream nft ocsupctl; do command -v $b 2>/dev/null; done; true",
  ]);
  const files = r.out.split("\n");
  const has = (re) => files.some((f) => re.test(f));
  const ocsup = dk([
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    tag,
    "-c",
    "wc -l < /opt/ocrt/ocsup.mjs; grep -c 'lib/' /opt/ocrt/ocsup.mjs",
  ]).out.split("\n");
  let wiring = {};
  const dump = dk(["run", "--rm", "--entrypoint", "node", tag, "-e", DUMP_JS]);
  try {
    wiring = wiringFeatures(JSON.parse(dump.out));
  } catch (e) {
    console.error(`wiring scan failed: ${String(e).slice(0, 200)} ${dump.err.slice(-300)}`);
  }
  return {
    ...wiring,
    files,
    contract: has(/lib\/contract\.mjs$/),
    ocio: has(/^\.\/ocio\//),
    // M1 layout: ocsup.mjs is a small entry over lib/main.mjs.
    m1: has(/lib\/main\.mjs$/) || Number(ocsup[1] || 0) >= 5,
    ocsupctl: (has(/lib\/main\.mjs$/) || Number(ocsup[1] || 0) >= 5) && has(/lib\/ctl\.mjs$/),
    ocsupLines: Number(ocsup[0] || 0),
    nft: files.some((f) => f.endsWith("/nft")),
  };
}

// Per-network lock: the docker network create of ocm1n<N> is the lock (harness/env.mjs acquireNet).
// Each run has its own fake gate, SeaweedFS and names, so runs do not reset each other.
try {
  acquireNet({ want: opt("--net") === undefined ? null : Number(opt("--net")) });
} catch (e) {
  console.error(String(e.message || e));
  process.exit(2);
}
console.log(`harness run slot ${N}: network ${PFX} (15.${N}.0.0/24), names ${PFX}-*`);
const teardown = () => {
  if (!flag("--keep")) envDown(N);
};
process.on("exit", teardown);
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    process.exit(130);
  });

const imageTag = opt("--image", `oc-m1:n${N}`);
const images = {};
let feats = {};
try {
  if (!flag("--no-build")) images.main = build(imageTag, opt("--base") ? { BASE: opt("--base") } : {});
  else images.main = { tag: imageTag, id: dk(["image", "inspect", "-f", "{{.Id}}", imageTag]).out };
  if (opt("--prev-image")) process.env.OCM1_UC_PREV = opt("--prev-image");
  else if (opt("--prev-base") && !flag("--no-build")) {
    images.prev = build(`${imageTag}-prev`, { BASE: opt("--prev-base") });
    process.env.OCM1_UC_PREV = images.prev.tag;
  }
  feats = features(imageTag);
  console.log(
    `image ${imageTag} ${images.main.id.slice(0, 19)} features ${JSON.stringify({ ...feats, files: undefined, wired: feats.wired?.length })}`,
  );
} catch (e) {
  console.error(String(e.message || e));
  process.exit(2);
}
const needs936 = [];
for (const n of selected) {
  const m = (await import(path.join(TESTS_DIR, `${n}.mjs`))).default;
  if ((m.images || []).includes("2026.9.36")) needs936.push(n);
}
if (needs936.length && !flag("--no-build"))
  images.v936 = build(`${imageTag}-2026.9.36`, { BASE: "ghcr.io/openclaw/openclaw:2026.9.36" });
else if (needs936.length) images.v936 = { tag: `${imageTag}-2026.9.36` };

const date = opt("--date", new Date().toISOString().slice(0, 10));
const dir = resultsDir(date, opt("--results"));
console.log("env up ...");
await envUp();
let failed = 0;
for (const name of selected) {
  const file = path.join(TESTS_DIR, `${name}.mjs`);
  if (!fs.existsSync(file)) {
    console.error(`no test ${name}`);
    failed++;
    continue;
  }
  const mod = (await import(file)).default;
  const ld = logDir(dir, name);
  const t = makeContext({ name, image: imageTag, images, features: feats, logDir: ld });
  await ctl("/_ctl/reset", { inst: "m1" });
  await ctl("/_ctl/faults", { clear: true });
  t.seq0 = (await ctl("/_ctl/state")).seq;
  const t0 = Date.now();
  console.log(`== ${name}`);
  let error = null;
  const missing = (mod.needs || []).filter((f) => !feats[f]);
  if (missing.length)
    t.block(
      `image lacks ${missing.join(", ")} (needs: ${mod.needs.join(", ")}; not reachable from ocsup.mjs)`,
    );
  else {
    try {
      await Promise.race([
        mod.run(t),
        new Promise((_, rej) =>
          setTimeout(
            () => rej(new Error(`timeout ${mod.timeoutMs || 900_000} ms`)),
            mod.timeoutMs || 900_000,
          ),
        ),
      ]);
    } catch (e) {
      error = String(e?.stack || e).slice(0, 2000);
      t.note(`ERROR ${error}`);
    }
  }
  for (const b of t.boxes) {
    fs.writeFileSync(path.join(ld, `${b.name}.log`), b.text());
    if (!flag("--keep")) b.rm();
  }
  try {
    fs.writeFileSync(
      path.join(ld, "gate.jsonl"),
      (await t.records()).map((r) => JSON.stringify(r)).join("\n"),
    );
  } catch {}
  const res = writeResult(dir, {
    name,
    source: mod.source,
    rule: mod.rule,
    image: images.main.id,
    imageTag,
    git: `${gitSha}${dirty ? "-dirty" : ""}`,
    startedAt: new Date(t0).toISOString(),
    ms: Date.now() - t0,
    checks: t.checks,
    measured: t.measured,
    notes: t.notes,
    blocked: t.blocked,
    error,
  });
  console.log(`== ${name}: ${res.status} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (statusOf(res) !== "pass") failed++;
}
console.log(`results: ${dir}/summary.md`);
process.exit(failed ? 1 : 0);
