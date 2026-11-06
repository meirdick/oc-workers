// Scope §4 M1 row 5 (part 1): a creds change reaches the fake CredStore in < 1 s (plan §4.10).
const N = 10;
export default {
  name: "creds-change-1s",
  source: "scope §4 M1 'Creds change -> fake store in < 1 s'; plan §4.10; contract §2 PUT /v1/creds",
  rule: `${N} writes of credentials/m1/token.json (new bytes each): each PUT /v1/creds reaches the fake < 1000 ms after the write; body sha256 matches the bytes; a delete gives a tombstone.`,
  needs: ["m1", "ocio", "credsync"],
  timeoutMs: 400_000,
  async run(t) {
    const b = t.box({ name: "a", gen: 1 });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    b.as1000("mkdir -p /home/node/.openclaw/credentials/m1 && chmod 700 /home/node/.openclaw/credentials");
    await t.sleep(3000);
    const lat = [];
    for (let i = 0; i < N; i++) {
      const since = (await t.gateState()).seq;
      const body = JSON.stringify({ token: `t-${i}-${Date.now()}` });
      const w = Date.now();
      b.as1000(
        `printf '%s' '${body}' > /home/node/.openclaw/credentials/m1/token.json.tmp && mv /home/node/.openclaw/credentials/m1/token.json.tmp /home/node/.openclaw/credentials/m1/token.json`,
      );
      let hit = null;
      while (!hit && Date.now() - w < 5000) {
        const r = await t.records({ since, plane: "control", route: "/v1/creds/" });
        hit = r.find((x) => x.method === "PUT" && /token\.json/.test(x.route));
        if (!hit) await t.sleep(50);
      }
      lat.push(hit ? hit.ts - w : null);
      await t.sleep(500);
    }
    const ok = lat.filter((x) => x !== null);
    t.measure("latencyMs", lat);
    t.measure("p50", ok.sort((a, b) => a - b)[Math.floor(ok.length / 2)] ?? null);
    t.check(`all ${N} changes < 1000 ms`, ok.length === N && ok.every((x) => x < 1000), lat);
    const st = await t.ctl("/_ctl/state?full=1");
    const v = st.credsFull?.["credentials/m1/token.json"];
    const want = b.as1000("sha256sum /home/node/.openclaw/credentials/m1/token.json").out.split(" ")[0];
    t.check("store sha256 = file sha256", v?.sha256 === want, { store: v?.sha256, file: want });
    const since = (await t.gateState()).seq;
    b.as1000("rm /home/node/.openclaw/credentials/m1/token.json");
    await t.sleep(2000);
    const del = (await t.records({ since, plane: "control", route: "/v1/creds/" })).find(
      (x) => x.method === "DELETE",
    );
    t.check("delete -> tombstone", !!del, del?.route);
  },
};
