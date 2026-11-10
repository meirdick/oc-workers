// Demo cutover 2026-11-05 (worker/test/results/DEMO-cutover-2026-11-05.md) and M6 polish live: on Cloudflare
// the container's "/" was owned by uid 2346. OpenClaw 2026.10.9 Doctor walks every ancestor of its temp
// root (@openclaw/fs-safe temp-workspace-admission: owner must be the euid, root, or the overflow uid) and of
// its SQLite staging root (snapshot/local-repository-directory-policy: owner euid or root), up to "/".
// A foreign "/" fails both: exit 1, ocsup exit 78 doctor-failed. This box gets "/" chowned to 2346:2346
// before ocsup starts (the CF shape); ocsup must give "/" back to root before any uid-1000 child runs.
// The live installs had state from earlier gens and an old config that names the firecrawl plugin (the render now maps it to cloudflare-web-fetch), so: boot 1 makes
// state (no Doctor), boot 2 from its snapshot runs Doctor with the foreign "/".
// Boot 1 gets a valid doc (the gateway refuses the retired key without Doctor); boot 2 adds the retired key.
const BASE = {
  channels: { telegram: { enabled: false } },
  tools: { web: { fetch: { provider: "firecrawl" } } },
  plugins: {
    entries: { firecrawl: { enabled: true, config: { webFetch: { baseUrl: "http://15.0.0.3" } } } },
  },
};
const DOC = { ...BASE, channels: { telegram: { enabled: false, timeoutSeconds: 30 } } };
// The exact live error: OpenClaw's temp root (/tmp/openclaw) through @openclaw/fs-safe, as uid 1000.
const TEMP_PROBE = `
import { createRequire } from "node:module";
const req = createRequire("/app/package.json");
const { withTempWorkspace } = await import(req.resolve("@openclaw/fs-safe/temp"));
const { resolveSecureTempRoot } = await import(req.resolve("@openclaw/fs-safe/secure-temp-root"));
try {
  const root = resolveSecureTempRoot({ preferredDir: "/tmp/openclaw", fallbackPrefix: "openclaw" });
  await withTempWorkspace({ rootDir: root, prefix: "probe-" }, async () => {});
  console.log("ok");
} catch (e) { console.log("fail " + e.message); }`;
const OCSUP = "/usr/bin/tini -s -- /usr/local/bin/node --max-old-space-size=256 /opt/ocrt/ocsup.mjs";
const FOREIGN_ROOT = ["--entrypoint", "/bin/sh"];
const foreignCmd = ["-c", `chown 2346:2346 / && exec ${OCSUP}`];

export default {
  name: "doctor-staged-owner",
  source:
    "DEMO-cutover-2026-11-05 Doctor exit 78 'temp workspace directory \"/\" has an untrusted owner uid 2346'",
  rule: 'Boot 1 makes state (firecrawl configured), SIGTERM, snapshot; boot 2 from it with "/" 2346:2346 at start, config v2 with a retired key, runDoctor: Doctor exit 0 (no doctor-failed), no "untrusted owner" or "staging ancestor" in its output, a doctor proposal, /startupz; "/" is 0:0 and not group/world writable after boot; a uid-1000 fs-safe temp workspace under /tmp/openclaw works (the live untrusted-owner error); ocsup logged rootfs-owner with the old uid 2346.',
  needs: ["m1", "guardBoot"],
  timeoutMs: 1_200_000,
  async run(t) {
    await t.ctl("/_ctl/config", { ver: 1, doc: BASE });
    const a = t.box({ name: "a", gen: 1, plan: { configVer: 1 } });
    await a.start();
    if (!t.check("a: /startupz", (await a.startupz(400_000)) !== null)) return;
    a.sigterm();
    await a.waitExit(400_000);
    const snap = a.snapshot();
    await t.ctl("/_ctl/config", { ver: 2, doc: DOC });
    const b = t.box({
      name: "b",
      image: snap,
      gen: 2,
      env: { OCRT_SNAPSHOT_ID: snap },
      plan: { rootfs: { kind: "snapshot", snapshotId: snap }, runDoctor: true, configVer: 2 },
      args: FOREIGN_ROOT,
      cmd: foreignCmd,
    });
    await b.start();
    const ms = await b.startupz(500_000);
    const exit = b.ev("exit").at(-1);
    const docs = b.ev("doctor");
    const out = `${exit?.detail || ""} ${JSON.stringify(docs)}`;
    t.measure("exit", exit || null);
    t.measure(
      "doctor",
      docs.map((d) => ({ code: d.code, exit: d.exit, ms: d.ms, tail: d.tail?.slice(-300) })),
    );
    t.check("no doctor-failed exit", exit?.reason !== "doctor-failed", exit);
    t.check(
      "Doctor exit 0",
      docs.some((d) => d.code === 0),
      docs.map((d) => d.code),
    );
    t.check("no untrusted-owner or staging-ancestor error", !/untrusted owner|staging ancestor/.test(out));
    t.check("/startupz", ms !== null, { ms });
    const root = b.sh("stat -c '%u:%g %a' /").out.trim();
    const [own, mode] = root.split(" ");
    t.check(
      '"/" root-owned, not group/world writable',
      own === "0:0" && (Number.parseInt(mode, 8) & 0o022) === 0,
      root,
    );
    const probe = b.as1000(["node", "--input-type=module", "-e", TEMP_PROBE]).out.trim();
    t.check("uid-1000 temp workspace under /tmp/openclaw (no untrusted owner)", probe === "ok", probe);
    const fix = b.ev("rootfs-owner").at(-1);
    t.check(
      "rootfs-owner logged with the old owner",
      fix?.fixed?.some((f) => f.path === "/" && f.uid === 2346),
      fix,
    );
    const st = await t.gateState();
    const props = st.config.proposals || [];
    t.check(
      "doctor proposal sent",
      props.some((x) => ["migrate", "doctor"].includes(x.source)),
      props.map((x) => x.source),
    );
  },
};
