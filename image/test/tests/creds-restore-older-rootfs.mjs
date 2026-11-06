// M4 loss drill finding (plan §6.2 step 8): a boot on a rootfs older than the CredStore writes the store's
// files, applies its tombstones, and does not roll the store back. Before the fix the reconcile scan
// tombstoned the newer files and re-uploaded the old bytes (live oc-m4-loss: creds.json lost after a SIGKILL).
const D = "/home/node/.openclaw/credentials/m4";
const atomic = (b, f, s) => b.as1000(`printf '%s' '${s}' > ${D}/${f}.tmp && mv ${D}/${f}.tmp ${D}/${f}`);

export default {
  name: "creds-restore-older-rootfs",
  source: "plan §6.2 step 8, §6.1 row 2; M4 loss drill",
  rule: "box b boots from a snapshot taken before the last creds writes: token.json = v2 (store), new.json present, old.json removed (tombstone), no PUT of the old token.json bytes, ocsup event creds-restore put 2 del 1.",
  needs: ["m1", "ocio", "credsync"],
  timeoutMs: 600_000,
  async run(t) {
    const a = t.box({ name: "a", gen: 1 });
    await a.start();
    if (!t.check("a: /startupz", (await a.startupz()) !== null)) return;
    a.as1000(`mkdir -p ${D} && chmod 700 /home/node/.openclaw/credentials ${D}`);
    atomic(a, "token.json", '{"v":1}');
    atomic(a, "old.json", '{"old":1}');
    await t.sleep(3000);
    const snap = a.snapshot(); // rootfs with token v1 and old.json
    atomic(a, "token.json", '{"v":2}');
    atomic(a, "new.json", '{"new":1}');
    a.as1000(`rm ${D}/old.json`);
    await t.sleep(3000);
    const v2sha = a.as1000(`sha256sum ${D}/token.json`).out.split(" ")[0];
    a.sigkill();
    await a.waitExit(30_000);
    const since = (await t.gateState()).seq;
    const b = t.box({
      name: "b",
      image: snap,
      gen: 2,
      restoreGens: [1],
      env: { OCRT_SNAPSHOT_ID: snap },
      plan: {
        rootfs: { kind: "snapshot", snapshotId: snap },
        sqlite: { kind: "gen", gen: 1 },
        restoreGens: [1],
      },
    });
    await b.start();
    if (!t.check("b: /startupz", (await b.startupz(240_000)) !== null)) return;
    await t.sleep(3000);
    const ev = b.ev("creds-restore").at(-1);
    t.measure("creds-restore", ev);
    const tok = b.as1000(`cat ${D}/token.json`).out.trim();
    const has = (f) => b.as1000(`test -f ${D}/${f} && echo yes || echo no`).out.trim() === "yes";
    t.check("token.json = v2 from the store", tok === '{"v":2}', tok);
    t.check("new.json written from the store", has("new.json"));
    t.check("old.json removed (store tombstone)", !has("old.json"));
    const puts = (await t.records({ since, plane: "control", route: "/v1/creds/" })).filter(
      (x) => x.method === "PUT" || x.method === "DELETE",
    );
    t.check("no PUT/DELETE after the boot (store not rolled back)", puts.length === 0, puts.slice(0, 4));
    const st = await t.ctl("/_ctl/state?full=1");
    t.check("store token.json sha = v2", st.credsFull?.["credentials/m4/token.json"]?.sha256 === v2sha);
    t.check("event creds-restore put 2 del 1", ev?.put === 2 && ev?.del === 1, ev);
  },
};
