// M4b N3 (M4 backup drill §2.7): at 100 % disk the gateway crash-looped, ocsup exited 70 and the install
// restarted from the last snapshot (rootfs writes lost). State dir on a 1200 MiB tmpfs; uid 1000 fills it.
// Rules: free < 512 MiB reserve → disk-low (disk-full alert, no archive, no shadow, Litestream low-disk
// config); at 100 % ocsup does not exit and the gateway is restarted (30 s, not counted); after the fill is
// removed the gateway is back at /startupz.
import { exitInfo, gateAlerts, gatewayPid } from "../harness/flows.mjs";

const FILL = "/home/node/.openclaw/m4b-fill";
export default {
  name: "m4b-disk-full",
  source: "M4-STATUS §7 N3; M4 backup drill 2.7; plan §4.12 disk watch",
  rule: "State tmpfs 1200 MiB. Fill to free < 512 MiB: disk-low on, disk-full alert, archive refused. Fill to 100 % for 150 s: ocsup still running, no exit 70, no gateway-crash-loop. Remove fill: /startupz again, disk-low off.",
  needs: ["m1", "ocsupctl", "diskwatch"],
  timeoutMs: 900_000,
  async run(t) {
    const b = t.box({
      name: "a",
      gen: 1,
      args: ["--tmpfs", "/home/node/.openclaw:size=1200m,uid=1000,gid=1000,mode=0755"],
    });
    await b.start();
    if (!t.check("/startupz", (await b.startupz()) !== null)) return;
    const df = () =>
      b.sh(["df", "-B1", "--output=avail", "/home/node/.openclaw"]).out.trim().split("\n").pop();
    t.measure("availStart", Number(df()));
    // Stage 1: leave ~300 MiB free (< 512 MiB reserve).
    const avail = Number(df());
    b.as1000(["sh", "-c", `head -c ${Math.max(0, avail - 300 * 1024 * 1024)} /dev/zero > ${FILL}.1`], {
      timeoutMs: 120_000,
    });
    t.measure("availStage1", Number(df()));
    const low = await b.waitEv((e) => e.ev === "disk-low" && e.on === true, 90_000);
    t.check("free < reserve → disk-low on", !!low, low);
    let alerts = [];
    for (let i = 0; i < 15 && !alerts.length; i++) {
      alerts = await gateAlerts(t, "disk-full");
      if (!alerts.length) await t.sleep(1000);
    }
    t.check("disk-full alert raised", alerts.length > 0, alerts.length);
    const ar = b.ctl("archive", { args: { kind: "online" } });
    t.measure("archiveWhileLow", ar);
    t.check("archive refused while low", /disk-low/.test(JSON.stringify(ar)), ar);
    // Stage 2: 100 %.
    b.as1000(["sh", "-c", `head -c 400000000 /dev/zero > ${FILL}.2; true`], { timeoutMs: 120_000 });
    t.measure("availFull", Number(df()));
    const ex0 = b.ev("gateway-exit").length;
    // The M4 live drill saw the gateway die on ENOSPC writes, then crash x4 in 25 s → exit 70. An idle Docker
    // gateway does not write enough to die, so kill it once at 100 %: each start must now write on a full disk.
    const gwPid = gatewayPid(b);
    if (gwPid) b.sh(`kill -KILL -${gwPid} 2>/dev/null || kill -KILL ${gwPid}`);
    t.measure("killedGatewayPid", gwPid);
    await t.sleep(150_000);
    const st = b.state();
    const exits = b.ev("gateway-exit").slice(ex0);
    t.measure(
      "gatewayExitsAtFull",
      exits.map((e) => ({ code: e.code, signal: e.signal, cls: e.cls })),
    );
    t.measure("diskFullRestarts", b.ev("gateway-exit-disk-full").length);
    t.measure("containerAt150s", st);
    t.check("ocsup still running at 100 % for 150 s", st.status === "running", st);
    const ex = b.ev("exit").at(-1);
    t.check("no exit 70 gateway-crash-loop", ex?.reason !== "gateway-crash-loop", ex ?? null);
    // Recover.
    b.sh(["rm", "-f", `${FILL}.1`, `${FILL}.2`]);
    const n0 = b.ev("startupz").length;
    const crashed = b.ev("gateway-exit").length > ex0;
    const back = crashed
      ? await b.waitEv((e) => e.ev === "startupz" && b.ev("startupz").length > n0, 240_000)
      : true;
    t.measure("gatewayAfterFree", { crashedAtFull: crashed, startupzAgain: !!back });
    t.check("gateway up after space is back", !!back && b.state().status === "running", {
      crashed,
      back: !!back,
    });
    const off = await b.waitEv((e) => e.ev === "disk-low" && e.on === false, 90_000);
    t.check("disk-low off after space is back", !!off, off);
    t.measure("exit", b.state().status === "running" ? null : await exitInfo(t, b));
  },
};
