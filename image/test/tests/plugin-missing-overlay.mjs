// Scope §4 M1 row 13 [Z1.6]; plan §4.9 "Plugin skipped at restore": a plugin missing on a snapshot-path
// boot -> plugin-missing overlay, no bad version.
const DOC = { plugins: { entries: { "m1-missing": { enabled: true } } } };

export default {
  name: "plugin-missing-overlay",
  source:
    "scope §4 M1 'A plugin missing on a snapshot-path boot -> plugin-missing overlay, no bad version' [Z1.6]",
  rule: "Manifest lists m1-missing, the rootfs has no such plugin, rootfs.kind snapshot: alert plugin-missing; openclaw.json plugins.entries.m1-missing.enabled false; overlay.json lists it; no config proposal; /startupz (boot continues, degraded).",
  needs: ["m1", "guardBoot"],
  timeoutMs: 600_000,
  async run(t) {
    await t.ctl("/_ctl/config", { ver: 1, doc: DOC });
    await t.ctl("/_ctl/plugins", {
      ver: 1,
      plugins: [{ id: "m1-missing", spec: "@oc-host-m1/missing-plugin@1.0.0" }],
    });
    // A snapshot-path boot: the box image stands in for the snapshot.
    const b = t.box({
      name: "a",
      gen: 1,
      env: { OCRT_SNAPSHOT_ID: "snap-m1-plugin" },
      plan: {
        rootfs: { kind: "snapshot", snapshotId: "snap-m1-plugin" },
        sqlite: { kind: "fresh" },
        configVer: 1,
        pluginsVer: 1,
      },
    });
    await b.start();
    if (!t.check("/startupz (boot continues)", (await b.startupz(400_000)) !== null)) return;
    const st = await t.gateState();
    t.check(
      "alert plugin-missing",
      (st.alerts || []).some((a) => a.class === "plugin-missing"),
      (st.alerts || []).map((a) => a.class),
    );
    let cfg = null;
    try {
      cfg = JSON.parse(b.as1000("cat /home/node/.openclaw/openclaw.json").out);
    } catch {}
    t.check(
      "plugin entry disabled in rendered config",
      cfg?.plugins?.entries?.["m1-missing"]?.enabled === false,
      cfg?.plugins?.entries,
    );
    t.check(
      "overlay.json lists the plugin",
      /m1-missing/.test(b.sh("cat /run/ocrt/overlay.json 2>/dev/null").out),
    );
    t.check(
      "no config proposal (no bad version, no migrate)",
      (st.config.proposals || []).length === 0,
      (st.config.proposals || []).length,
    );
  },
};
