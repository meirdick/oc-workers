// Scope §4 M1 row 8 (part 1); plan §4.13: planted symlinks and hard links give no root read or write.
import { gateEvents } from "../harness/flows.mjs";

const S = "/home/node/.openclaw";
// Targets root can read but uid 1000 cannot: /etc/shadow, /var/lib/ocrt/boot_id-like files, /proc/1/environ.
const PLANT = `set -e
mkdir -p ${S}/credentials/m1 ${S}/agents/evil/agent ${S}/agents/hl/agent ${S}/workspace
ln -sf /etc/shadow ${S}/credentials/m1/shadow.json
ln -sf /proc/1/environ ${S}/credentials/m1/environ.json
printf '{"k":1}' > ${S}/credentials/m1/real.json
printf '{"k":2}' > ${S}/credentials/m1/linked.json
ln -f ${S}/credentials/m1/linked.json ${S}/credentials/m1/hardlink.json
ln -sf /var/lib/ocrt/status.json ${S}/agents/evil/agent/openclaw-agent.sqlite
node -e 'const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync(process.argv[1]);c.exec("PRAGMA journal_mode=WAL;create table t(x)");c.close()' ${S}/agents/hl/agent/real.sqlite
ln -f ${S}/agents/hl/agent/real.sqlite ${S}/agents/hl/agent/openclaw-agent.sqlite
ln -sfn /opt/ocrt ${S}/workspace/ocrt-link
ln -sf /etc/passwd ${S}/openclaw.json.m1-planted
echo planted`;

export default {
  name: "symlink-and-hardlink-plants",
  source: "scope §4 M1 'Planted symlinks and hard links give no root read or write'; plan §4.13",
  rule: "After plants in credentials/, agents/ and the state dir and 40 s of scans: no creds PUT carries a symlink or nlink>1 file; no DB with a symlink or hard link enters the Litestream set; /etc/shadow, /opt/ocrt and /var/lib/ocrt files keep their sha256 and owner; no root-owned entry appears under $STATE.",
  needs: ["m1", "ocio", "credsync"],
  timeoutMs: 400_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1 });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    const sums = () =>
      b.sh(
        "sha256sum /etc/shadow /etc/passwd /opt/ocrt/ocsup.mjs; stat -c '%U %a %n' /etc/shadow /opt/ocrt /var/lib/ocrt",
      ).out;
    const before = sums();
    const r = b.as1000(PLANT);
    t.check("plants made as uid 1000", /planted/.test(r.out), r.err.slice(-300) || undefined);
    const since = (await t.gateState()).seq;
    b.ctl("shadow-backup");
    await t.sleep(40_000);
    const creds = (await t.records({ since, plane: "control", route: "/v1/creds/" })).filter(
      (x) => x.method === "PUT",
    );
    // real.json stays nlink 1; linked.json and hardlink.json share an inode (nlink 2): both refused.
    const bad = creds.filter((x) => /shadow|environ|hardlink|linked/.test(x.route));
    t.measure(
      "credPuts",
      creds.map((x) => x.route),
    );
    t.check(
      "no creds PUT for symlink or hard-link files",
      bad.length === 0,
      bad.map((x) => x.route),
    );
    t.check(
      "real.json still synced (scan works)",
      creds.some((x) => /real\.json/.test(x.route)),
      creds.length,
    );
    const lsSet = (await gateEvents(t, "replica-set")).map((e) => e.body?.detail);
    const yml = b.sh("cat /run/ocrt/litestream.yml 2>/dev/null").out;
    t.check("no planted DB in the Litestream config", !/agents\/(evil|hl)\//.test(yml), lsSet.slice(-1));
    const keys = (await t.records({ since, plane: "replica" })).filter((x) =>
      /agents\/(evil|hl)\//.test(x.key || ""),
    );
    t.check("no ReplicaGate key for planted DBs", keys.length === 0, keys.map((x) => x.key).slice(0, 3));
    const after = sums();
    t.check(
      "root files unchanged (sha256, owner, mode)",
      before === after,
      before === after ? undefined : { before, after },
    );
    const rootOwned = b.sh(`find ${S} -xdev -user root 2>/dev/null | head -5`).out;
    t.check("no root-owned entry under $STATE", rootOwned === "", rootOwned);
  },
};
