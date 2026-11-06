// M6 `ochost upgrade run` image contract (plan §8.2, trimmed to what Docker alone shows). Run on the image
// under test (t.image = the candidate). With OCM1_UC_PREV (a tag built FROM the pinned release) the
// candidate boots on that release's state, which is the real upgrade path:
//   node image/test/run.mjs _upgrade-contract --base ghcr.io/openclaw/openclaw:2026.9.36 \
//     --prev-base ghcr.io/openclaw/openclaw@sha256:1a2a3ce1...
// Checks: base facts (version, Debian 12, glibc 2.36, label); database preflight on a copy of the pinned
// release's state DB must be `exact` (anything else is a schema change, out of scope: refuse); Doctor exit
// 0 and no config migrate proposal; /startupz; lock probe (SIGKILL + new boot_id, gateway SIGKILL in place);
// SIGTERM exit 0 under 330 s. `schema` in the result tells the CLI why a candidate was refused.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dk } from "../harness/docker.mjs";
import { exitInfo, gatewayPid } from "../harness/flows.mjs";
import { DB_STATE, STATE, writeRows } from "../harness/sqlite.mjs";

const OC = "/app/openclaw.mjs";
const waitLine = (b) =>
  b.events().filter((e) => e.ev === "lock-wait" || (e.ev === "lock" && /wait/.test(String(e.action || ""))));

/** `database preflight <copy> --json` of the candidate on a copy of box `from`'s state DB. */
function preflight(from, image) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocm1-pf-"));
  for (const sfx of ["", "-wal", "-shm"]) {
    const b = from.cat(path.join(STATE, `${DB_STATE}${sfx}`));
    if (b) fs.writeFileSync(path.join(dir, `x.sqlite${sfx}`), b);
  }
  fs.chmodSync(dir, 0o777);
  for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o666);
  // preflight wants a standalone file: checkpoint the copy, drop the sidecars, then compare.
  const script = `node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/w/x.sqlite");d.exec("PRAGMA wal_checkpoint(TRUNCATE)");d.close()' && rm -f /w/x.sqlite-wal /w/x.sqlite-shm && node ${OC} database preflight /w/x.sqlite --json`;
  const r = dk([
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${dir}:/w`,
    "--entrypoint",
    "sh",
    image,
    "-c",
    script,
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    return JSON.parse(r.out);
  } catch {
    return { status: "unparsed", error: (r.err || r.out).slice(-300), code: r.code };
  }
}

export default {
  name: "_upgrade-contract",
  source: "plan §8.2; docs/10-cli-spec.md upgrade run (M6 quick win)",
  rule: "Candidate: base facts; preflight exact on the pinned release's state; Doctor 0 and no migrate proposal; /startupz; lock probe; SIGTERM exit 0 < 330 s.",
  timeoutMs: 1_800_000,
  async run(t) {
    const img = t.image;
    const prev = process.env.OCM1_UC_PREV;
    const want = process.env.OCM1_UC_VERSION;
    const info = dk([
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      img,
      "-c",
      `node -p 'require("/app/package.json").version'; . /etc/os-release; echo $VERSION_ID; ldd --version | head -1; node -v`,
    ]);
    const [ver, osid, glibc, nodev] = info.out.split("\n");
    const label = dk([
      "image",
      "inspect",
      "-f",
      '{{index .Config.Labels "oc-host.openclaw.version"}}',
      img,
    ]).out;
    t.measure("base", { version: ver, os: osid, glibc, node: nodev, label });
    t.check("version matches the request", !want || ver === want, { ver, want });
    t.check("label oc-host.openclaw.version", label === ver, { label, ver });
    t.check("base is Debian 12", osid === "12", osid);
    t.check("glibc 2.36 (libjemalloc and nft built against it)", /2\.36/.test(glibc || ""), glibc);
    t.check(
      "jemalloc preload works",
      dk([
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        img,
        "-c",
        "LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2 node -e 0",
      ]).code === 0,
    );

    // Pinned release first: its state is what the candidate must read.
    let from = null;
    let gen = 1;
    if (prev) {
      from = t.box({ name: "prev", image: prev, gen });
      await from.start();
      if (!t.check("prev: /startupz", (await from.startupz(240_000)) !== null)) return;
      writeRows(from, 20, { tag: "prev" });
      await t.sleep(12_000);
      from.sigterm();
      await from.waitExit(300_000);
      t.check("prev: exit 0", from.state().exitCode === 0, await exitInfo(t, from));
      gen++;
    } else t.note("no OCM1_UC_PREV: schema check runs on the candidate's own fresh state");

    const b = t.box({
      name: "cand",
      gen,
      restoreGens: prev ? [1] : [],
      plan: {
        runDoctor: true,
        ...(prev ? { sqlite: { kind: "gen", gen: 1 } } : {}),
        restoreGens: prev ? [1] : [],
      },
    });
    await b.start();
    const ms = await b.startupz(400_000);
    t.measure("cand.startupzMs", ms);
    if (!t.check("cand: /startupz", ms !== null, ms === null ? await exitInfo(t, b) : { ms })) return;
    // ocsup exits 78 (doctor-failed) on a Doctor failure, so reaching /startupz already means exit 0; the CLI
    // event with the exit code is read when present.
    const docs = b.ev("doctor");
    t.measure(
      "cand.doctor",
      docs.map((e) => ({ code: e.code, ms: e.ms })),
    );
    t.check(
      "cand: Doctor ran, exit 0",
      docs.length > 0 && docs.every((e) => e.code === undefined || e.code === 0),
      docs.length,
    );
    const props = ((await t.gateState()).config?.proposals || []).filter((p) => p.source === "migrate");
    t.check("cand: no config migrate proposal", props.length === 0, props.length);

    // Database preflight: the candidate against the state the pinned release wrote.
    const src = prev ? from : b;
    const pf = preflight(src, img);
    t.measure("preflight", pf);
    const schema = { status: pf.status, found: pf.foundVersion, target: pf.targetVersion };
    t.measure("schema", schema);
    t.check("database preflight is exact (else a schema change: refuse)", pf.status === "exact", schema);

    // Lock probe (plan §8.2 cases 1 and 2).
    writeRows(b, 10, { tag: "cand" });
    await t.sleep(3000);
    b.sigkill();
    await b.waitExit(30_000);
    const snap = b.snapshot();
    const c = t.box({
      name: "relock",
      image: snap,
      gen: gen + 1,
      restoreGens: [gen],
      env: { OCRT_SNAPSHOT_ID: snap },
      plan: {
        rootfs: { kind: "snapshot", snapshotId: snap },
        sqlite: { kind: "gen", gen },
        restoreGens: [gen],
      },
    });
    await c.start();
    const msC = await c.startupz(300_000);
    t.measure("lock.newBootMs", msC);
    t.check("lock 1: SIGKILL + new boot_id reaches /startupz", msC !== null, { msC });
    t.check("lock 1: no lock wait line", waitLine(c).length === 0, waitLine(c).slice(0, 2));
    const pid = gatewayPid(c);
    const n0 = c.ev("startupz").length;
    const t0 = Date.now();
    c.sh(`kill -KILL -${pid} 2>/dev/null || kill -KILL ${pid}`);
    const again = await c.waitEv((e) => e.ev === "startupz" && c.ev("startupz").length > n0, 300_000);
    t.measure("lock.gatewayKillMs", again ? Date.now() - t0 : null);
    t.check("lock 2: gateway SIGKILL restarts to /startupz", !!again, { pid });
    t.check("lock 2: no lock wait line", waitLine(c).length === 0, waitLine(c).slice(0, 2));

    const s0 = Date.now();
    c.sigterm();
    await c.waitExit(330_000);
    const secs = (Date.now() - s0) / 1000;
    t.measure("sigterm.s", secs);
    t.check("SIGTERM exit 0 under 330 s", c.state().exitCode === 0 && secs < 330, {
      secs,
      ...(await exitInfo(t, c)),
    });
  },
};
