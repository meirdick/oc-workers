// Scope §4 M1 row 9 [Z1.7]: an unknown *.sqlite (team-reports fixture) is shadowed with db-unclassified.
const S = "/home/node/.openclaw";
const FIX = `mkdir -p ${S}/workspace/team-reports && node -e 'const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync(process.argv[1]);c.exec("create table reports(id integer primary key, body text)");const i=c.prepare("insert into reports(body) values(?)");for(let n=0;n<100;n++)i.run("r"+n);c.close();console.log("ok")' ${S}/workspace/team-reports/reports.sqlite`;

export default {
  name: "unknown-sqlite-shadowed",
  source: "scope §4 M1 'unknown *.sqlite ... shadowed with db-unclassified' [Z1.7]; plan §4.11",
  rule: "A non-managed SQLite under workspace/: alert or event db-unclassified; a PUT /v1/shadow/<db> reaches the fake (after ocsupctl shadow-backup); the file is not in the Litestream set.",
  needs: ["ocsupctl", "shadow"],
  timeoutMs: 300_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1 });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    t.check("fixture written", /ok/.test(b.as1000(FIX).out));
    const since = (await t.gateState()).seq;
    await t.sleep(35_000); // >= one 30 s DB-set scan
    const sb = b.ctl("shadow-backup");
    t.measure("shadowBackup", sb);
    await t.sleep(5000);
    const recs = await t.records({ since });
    const shadow = recs.filter((r) => /^\/v1\/shadow\//.test(r.route || ""));
    const unclass = recs.filter((r) => /db-unclassified/.test(JSON.stringify(r.body || {})));
    t.measure(
      "shadowPuts",
      shadow.map((r) => r.route),
    );
    t.check(
      "db-unclassified reported",
      unclass.length > 0 || b.events().some((e) => /db-unclassified/.test(JSON.stringify(e))),
    );
    t.check(
      "shadow PUT for reports.sqlite",
      shadow.some((r) => /reports/.test(decodeURIComponent(r.route))),
      shadow.length,
    );
    t.check(
      "not in Litestream config",
      !/team-reports/.test(b.sh("cat /run/ocrt/litestream.yml 2>/dev/null").out),
    );
  },
};
