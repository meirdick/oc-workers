// M3 fix B1 (worker/test/results/M2-live-B.md B1, spec 08 §8.3 "Workspace"): a gen restore onto a rootfs
// without the workspace (image path after an image deploy, or an older rootfs) left an attested workspace
// empty, and OpenClaw answered every message with "workspace is missing". ocsup must never start that
// gateway: exit 75 restore-blocked:mismatch + alert workspace-missing; with the owner's acceptLoss it clears
// the attestation, alerts workspace-reset and starts; a snapshot rootfs that holds the workspace passes.
import { exitInfo, gateAlerts, gateEvents } from "../harness/flows.mjs";
import { STATE } from "../harness/sqlite.mjs";

const WS = `${STATE}/workspace`;
// As uid 1000: mark the workspace as seeded and attested in the state DB (OpenClaw 2026.9.x columns).
const ATTEST = `
const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync(process.argv[1]);c.exec("PRAGMA busy_timeout=5000");
c.prepare("INSERT OR REPLACE INTO workspace_setup_state (workspace_key, workspace_path, version, bootstrap_seeded_at, updated_at, attested_at_ms) VALUES (?,?,1,?,?,?)")
 .run("m3-b1",process.argv[2],new Date().toISOString(),Date.now(),Date.now());c.close();`;
const COUNT = `
const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync(process.argv[1],{readOnly:true});
console.log(JSON.stringify(c.prepare("SELECT count(*) n FROM workspace_setup_state WHERE workspace_key='m3-b1'").get()));c.close();`;

const genPlan = (extra = {}) => ({
  rootfs: { kind: "image" },
  sqlite: { kind: "gen", gen: 1 },
  restoreGens: [1],
  dbs: [{ db: "state/openclaw.sqlite", state: "uploaded", lastTxid: 0, bytes: 0 }],
  ...extra,
});

export default {
  name: "workspace-missing-gen-restore",
  source: "M2-live-B B1; spec 08 §8.3 Workspace; M3 fix B1",
  rule: "gen restore on a rootfs without the attested workspace → exit 75 restore-blocked:mismatch, alert workspace-missing, no gateway start; acceptLoss → attestation cleared, alert workspace-reset, /startupz; snapshot rootfs with the workspace → /startupz.",
  timeoutMs: 900_000,
  async run(t) {
    // gen 1: fresh boot, a workspace file, the attestation row; Litestream ships it; then a clean kill.
    const a = t.box({ name: "a", gen: 1 });
    await a.start();
    if (!t.check("a: /startupz", (await a.startupz()) !== null)) return;
    a.as1000(["sh", "-c", `mkdir -p ${WS} && echo agent > ${WS}/AGENTS.md`]);
    const w = a.as1000(["node", "-e", ATTEST, `${STATE}/state/openclaw.sqlite`, WS], { timeoutMs: 30_000 });
    t.check("a: attestation row written", w.code === 0, { err: String(w.err || "").slice(-300) });
    await t.sleep(8000); // Litestream sync (1 s) + upload
    const snap = a.snapshot(); // rootfs holding the workspace
    a.sigkill();
    await a.waitExit(30_000);

    // (1) image rootfs + gen 1, no workspace source → refuse.
    const b = t.box({
      name: "b",
      gen: 2,
      restoreGens: [1],
      plan: genPlan({ workspace: { source: "none" } }),
    });
    await b.start();
    await b.waitExit(240_000);
    const xb = await exitInfo(t, b);
    t.measure("b.exit", xb);
    t.check(
      "(1) exit 75 restore-blocked:mismatch",
      xb.code === 75 && xb.reason === "restore-blocked:mismatch",
      xb,
    );
    const gwB = (await gateEvents(t, "gateway-starting")).filter((e) => e.body?.gen === 2);
    t.check("(1) no gateway start", gwB.length === 0 && b.ev("gateway-starting").length === 0, gwB.length);
    const alB = await gateAlerts(t, "workspace-missing");
    t.check(
      "(1) alert workspace-missing (high)",
      alB.some((x) => x.severity === "high"),
      alB.slice(0, 2),
    );

    // (2) same, owner acceptLoss → reset + start.
    const c = t.box({
      name: "c",
      gen: 3,
      restoreGens: [1],
      plan: genPlan({ workspace: { source: "none", acceptLoss: true } }),
    });
    await c.start();
    const msC = await c.startupz(300_000);
    t.measure("c.startupzMs", msC);
    t.check("(2) acceptLoss: /startupz", msC !== null, msC === null ? await exitInfo(t, c) : undefined);
    const alC = await gateAlerts(t, "workspace-reset");
    t.check("(2) alert workspace-reset", alC.length > 0, alC.slice(0, 2));
    const cnt = c.as1000(["node", "-e", COUNT, `${STATE}/state/openclaw.sqlite`], { timeoutMs: 30_000 });
    t.check("(2) attestation row gone", /"n":0/.test(String(cnt.out)), String(cnt.out).trim());
    c.sigterm();
    await c.waitExit(120_000);

    // (3) snapshot rootfs (holds the workspace) + gen 1 → passes the check.
    const d = t.box({
      name: "d",
      image: snap,
      gen: 4,
      restoreGens: [1],
      env: { OCRT_SNAPSHOT_ID: snap },
      plan: genPlan({ rootfs: { kind: "snapshot", snapshotId: snap }, workspace: { source: "snapshot" } }),
    });
    await d.start();
    const msD = await d.startupz(300_000);
    t.measure("d.startupzMs", msD);
    t.check("(3) snapshot rootfs: /startupz", msD !== null, msD === null ? await exitInfo(t, d) : undefined);
    const stepD = d.events().find((e) => e.ev === "step" && e.step === "workspace");
    t.check("(3) workspace step passed, 0 missing", !!stepD && (stepD.missing || []).length === 0, stepD);
  },
};
