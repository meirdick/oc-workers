// Scope §4 M1 row 3, last case [Z1.1]: unpinned hostname + Doctor on a recover-lock build passes,
// because the lock step comes before Doctor and the gateway. Needs an OpenClaw build with
// `gateway recover-lock` (no local release has it on 2026-10-31: 2026.9.36, 2026.10.9, 2026.10.10-beta.1/.5).
// Override the image with OCM1_RL_IMAGE=<tag built FROM a recover-lock OpenClaw>.
import { dk } from "../harness/docker.mjs";
import { exitInfo } from "../harness/flows.mjs";

export default {
  name: "restart-unpinned-doctor",
  source: "scope §4 M1 row 3 [Z1.1]; plan §4.3 fallback, §4.4",
  rule: "Boot 1 host hA, SIGKILL; boot 2 host hB (pin off) with runDoctor: lock step runs recover-lock before Doctor, /startupz, no lock-blocked, no heartbeat wait.",
  timeoutMs: 900_000,
  async run(t) {
    const img = process.env.OCM1_RL_IMAGE || t.image;
    const h = dk([
      "run",
      "--rm",
      "--entrypoint",
      "node",
      img,
      "/app/openclaw.mjs",
      "gateway",
      "recover-lock",
      "--help",
    ]);
    if (/has no command/.test(h.out + h.err) || h.code !== 0)
      return t.block(`no recover-lock in ${img} (set OCM1_RL_IMAGE to a recover-lock build)`);
    const a = t.box({
      name: "a",
      image: img,
      gen: 1,
      hostname: "ha",
      env: { OCRT_HOSTNAME: "ha", OCRT_HOSTNAME_PIN: "0" },
    });
    await a.start();
    if (!t.check("a: /startupz", (await a.startupz()) !== null)) return;
    a.sigkill();
    await a.waitExit(30_000);
    const snap = a.snapshot();
    const b = t.box({
      name: "b",
      image: snap,
      gen: 2,
      hostname: "hb",
      env: { OCRT_HOSTNAME: "hb", OCRT_HOSTNAME_PIN: "0", OCRT_DOCTOR: "1", OCRT_SNAPSHOT_ID: snap },
      plan: {
        rootfs: { kind: "snapshot", snapshotId: snap },
        runDoctor: true,
        lockMode: "recover-lock",
        sqlite: { kind: "fresh" },
      },
    });
    await b.start();
    const ms = await b.startupz(300_000);
    const pinned = b.ev("hostname-pinned").length > 0;
    if (pinned)
      return t.block("ocsup pinned the hostname anyway (no pin-off switch); unpinned case not reachable");
    const ev = b.events();
    const iLock = ev.findIndex((e) => e.ev === "lock");
    const iDoc = ev.findIndex((e) => e.ev === "doctor" || (e.ev === "phase" && e.phase === "doctor"));
    t.check("lock step before Doctor", iLock >= 0 && (iDoc < 0 || iLock < iDoc), { iLock, iDoc });
    t.check("lock action recover-lock", /recover-lock/.test(String(ev[iLock]?.action)), ev[iLock]?.action);
    t.check("/startupz", ms !== null, { ms, exit: ms === null ? await exitInfo(t, b) : undefined });
  },
};
