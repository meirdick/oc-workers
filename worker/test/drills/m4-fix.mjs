// M4 fix drills on a live install (OC_TEST=1). Each step runs a drill, waits on state, asserts, and writes one
// JSON result line to $OUT (and prints it). Rerun in M7 against any oc-host install with the test routes.
// usage: node m4-fix.mjs <step>   env: U (origin), T (CONTROL_TOKEN), GW (gateway token), KEY (LLM key value), OUT
// steps:
//   install  F12 + F9: fresh install, zero posted config: wake → running; ring image-known (first pull), no
//            stuck/hung-start, no restart-* alert
//   ui       F9: owner code login, Control UI WS connect ok with operator.admin (no config was posted)
//   m31      M3-1: every gateway child: environ unreadable by uid 1000, no secret value, nodump preload
//   a1       A1: orphan cron row (staging store key, past time) → gateway restart → row deleted, alert cron-orphan
//   ws       ingress: revoke closes 1008; idle-close 1000 + latch (upgrade 503) + page load clears; 24 h cap 1008
//   rpo      A4: always-on bulk RPO: marker writes, checkpoint, SIGKILL; which writes survive
//   cost     instance-seconds from the Control DO meter (GraphQL is read by the caller)
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const U = (process.env.U ?? "").replace(/\/$/, "");
const T = process.env.T;
const GW = process.env.GW;
const KEY = process.env.KEY;
const OUT = process.env.OUT ?? "/tmp/m4-fix.jsonl";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (msg, o) => console.error(`${new Date().toISOString()} ${msg} ${o ? JSON.stringify(o) : ""}`);
const now = () => Date.now();
const iso = (t) => (t ? new Date(t).toISOString() : null);

function emit(step, r) {
  const checks = r.checks ?? {};
  const pass = Object.values(checks).every(Boolean);
  const line = JSON.stringify({ step, at: iso(now()), pass, ...r });
  console.log(line);
  appendFileSync(OUT, `${line}\n`);
  return pass;
}
async function ops(method, path, body) {
  const t0 = now();
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${U}${path}`, {
        method,
        headers: { authorization: `Bearer ${T}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: r.status, json, text, ms: now() - t0 };
    } catch (e) {
      if (i >= 3) return { status: 0, json: null, text: String(e), ms: now() - t0 };
      await sleep(1000);
    }
  }
}
const status = async () => (await ops("GET", "/ops/status")).json ?? {};
const rtState = async () => {
  const s = await status();
  return s.runtime?.state ?? s.rt?.state ?? s.state ?? null;
};
const det = (e) => {
  try {
    return typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail;
  } catch {
    return e.detail;
  }
};
async function ring(t0) {
  const ev = ((await ops("GET", "/ops/events?limit=500")).json?.events ?? []).reverse();
  return ev.filter((e) => e.at >= t0).map((e) => ({ ...e, d: det(e) }));
}
async function alerts(t0) {
  const r = await ops("GET", "/ops/alerts");
  const list = r.json?.alerts ?? r.json?.rows ?? [];
  return list.filter((a) => (a.last_sent_at ?? a.at ?? a.created_at ?? 0) >= t0);
}
async function waitFor(fn, timeoutMs, everyMs = 2000) {
  const t0 = now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return { v, ms: now() - t0 };
    if (now() - t0 > timeoutMs) return { v: null, ms: now() - t0, timeout: true };
    await sleep(everyMs);
  }
}
async function exec(cmd, timeoutMs = 60_000) {
  const r = await ops("POST", "/ops/fault", { name: "exec", params: { cmd, timeoutMs } });
  return r.json ?? { ok: false, error: r.text.slice(0, 300), status: r.status };
}
const node1000 = (js, args = [], t) =>
  exec(["setpriv", "--reuid=1000", "--regid=1000", "--init-groups", "node", "-e", js, ...args], t);
async function running(timeoutMs = 300_000) {
  return waitFor(async () => ((await rtState()) === "running" ? true : null), timeoutMs, 3000);
}

// ---- owner session + WS (Control UI shape) ----
async function login() {
  const c = await ops("POST", "/ops/auth/code", {});
  const r = await fetch(c.json.url, { redirect: "manual" });
  const sc = r.headers.get("set-cookie") ?? "";
  const cookie = sc.split(";")[0];
  const sess = (await ops("GET", "/ops/auth/sessions")).json?.sessions ?? [];
  const mine = sess.sort((a, b) => b.createdAt - a.createdAt)[0];
  return { cookie, id: mine?.id, status: r.status };
}
/** HTTP status of a WS upgrade or a page GET (curl: undici fetch refuses an Upgrade header). */
function curlStatus(cookie, { ws = false } = {}) {
  const h = ws
    ? [
        "-H",
        "upgrade: websocket",
        "-H",
        "connection: Upgrade",
        "-H",
        "sec-websocket-version: 13",
        "-H",
        "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==",
        "-H",
        `origin: ${U}`,
      ]
    : ["-H", "accept: text/html"];
  try {
    return Number(
      execFileSync(
        "curl",
        [
          "--http1.1",
          "-s",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "--max-time",
          "8",
          "-H",
          `cookie: ${cookie}`,
          ...h,
          `${U}/`,
        ],
        {
          encoding: "utf8",
        },
      ),
    );
  } catch (e) {
    return Number(String(e.stdout ?? "").trim()) || 0; // timeout after a 101 still prints the code
  }
}
const upgradeStatus = (cookie) => curlStatus(cookie, { ws: true });
function openWs(cookie, { connect = true } = {}) {
  return new Promise((resolve) => {
    const o = { t0: now(), closed: null };
    const sock = new WebSocket(`${U.replace(/^http/, "ws")}/`, { headers: { cookie, origin: U } });
    o.sock = sock;
    o.send = (method) => {
      try {
        sock.send(JSON.stringify({ type: "req", id: `r${Math.random()}`, method, params: {} }));
        return true;
      } catch {
        return false;
      }
    };
    o.done = new Promise((r) => {
      sock.addEventListener("close", (e) => {
        o.closed = { code: e.code, reason: e.reason, atMs: now() - o.t0, at: now() };
        r(o.closed);
        resolve(o);
      });
    });
    sock.addEventListener("error", (e) => {
      o.err = String(e.message ?? "error");
    });
    sock.addEventListener("message", (e) => {
      let m = {};
      try {
        m = JSON.parse(String(e.data));
      } catch {}
      if (m.type === "event" && m.event === "connect.challenge" && connect)
        sock.send(
          JSON.stringify({
            type: "req",
            id: "c1",
            method: "connect",
            params: {
              minProtocol: 4,
              maxProtocol: 4,
              client: { id: "openclaw-control-ui", version: "m4", platform: "linux", mode: "ui" },
              role: "operator",
              scopes: ["operator.read", "operator.admin"],
            },
          }),
        );
      else if (m.type === "res" && m.id === "c1") {
        o.connect = { ok: m.ok, err: m.error?.message, scopes: m.payload?.auth?.scopes ?? m.payload?.scopes };
        o.openAt = now();
        resolve(o);
      }
    });
    setTimeout(() => resolve(o), 30_000);
  });
}

// ---- steps ----
const steps = {
  async install() {
    const t0 = now();
    const cfg = await ops("GET", "/ops/config");
    const w = await ops("POST", "/ops/wake?wait=1", {});
    const up = await running(600_000);
    const ev = await ring(t0 - 1000);
    const known = ev.find((e) => e.src === "rt" && e.kind === "image-known");
    const stuck = ev.filter((e) => e.src === "rt" && e.kind === "stuck");
    const hung = ev.filter((e) => JSON.stringify(e.d ?? "").includes("hung-start"));
    const al = await alerts(t0 - 1000);
    const startupz = ev.find((e) => e.kind === "startupz");
    return emit("install", {
      wake: { status: w.status, ms: w.ms, state: w.json?.state ?? null },
      configVersions: cfg.json?.versions?.length ?? cfg.json?.rows?.length ?? null,
      runningMs: up.ms,
      firstAliveMs: known?.d?.firstAliveMs ?? null,
      startupzDetail: startupz?.d ?? null,
      stuck: stuck.length,
      hungStart: hung.length,
      alerts: al.map((a) => a.class ?? a.cls),
      checks: {
        running: !!up.v,
        imageKnown: !!known,
        noStuck: stuck.length === 0,
        noHungStart: hung.length === 0,
        noRestartAlert: !al.some((a) => /^restart-/.test(a.class ?? a.cls ?? "")),
      },
    });
  },

  async ui() {
    await running();
    const s = await login();
    const ws = await openWs(s.cookie);
    const ok = !!ws.connect?.ok;
    try {
      ws.sock.close(1000);
    } catch {}
    return emit("ui", {
      redeem: s.status,
      connect: ws.connect ?? null,
      closed: ws.closed,
      connectMs: ws.openAt ? ws.openAt - ws.t0 : null,
      checks: {
        cookie: !!s.cookie,
        connectOk: ok,
        admin: (ws.connect?.scopes ?? []).includes("operator.admin"),
      },
    });
  },

  async m31() {
    await running();
    const probe = `const fs=require("fs");const cp=require("child_process");
const gw=JSON.parse(fs.readFileSync("/var/lib/ocrt/status.json","utf8")).gateway.pid;
const all=[];for(const d of fs.readdirSync("/proc")){if(!/^\\d+$/.test(d))continue;try{const st=fs.readFileSync("/proc/"+d+"/stat","utf8");
all.push({pid:+d,ppid:+st.slice(st.lastIndexOf(")")+2).split(" ")[1],cmd:fs.readFileSync("/proc/"+d+"/cmdline","utf8").split("\\0").join(" ").slice(0,90)})}catch{}}
const below=new Set([gw]);for(let i=0;i<6;i++)for(const p of all)if(below.has(p.ppid))below.add(p.pid);below.delete(gw);
const secrets=process.argv.slice(1).filter(s=>s&&s.length>=8);const genv=fs.readFileSync("/proc/"+gw+"/environ","utf8");
const pw=(/(?:^|\\0)OPENCLAW_GATEWAY_PASSWORD=([^\\0]*)/.exec(genv)||[])[1];if(pw)secrets.push(pw);
const rows=[];for(const p of all.filter(x=>below.has(x.pid))){let env="";try{env=fs.readFileSync("/proc/"+p.pid+"/environ","utf8")}catch{continue}
let u;try{cp.execFileSync("setpriv",["--reuid=1000","--regid=1000","--clear-groups","head","-c","1","/proc/"+p.pid+"/environ"],{stdio:"pipe"});u="READ"}catch{u="DENIED"}
rows.push({pid:p.pid,cmd:p.cmd,uid1000:u,leaks:secrets.filter(s=>env.includes(s)).length,bad:env.split("\\0").map(l=>l.split("=")[0]).filter(n=>/^OC_|^OPENCLAW_GATEWAY_(PASSWORD|TOKEN)$/.test(n)),preload:(/(?:^|\\0)LD_PRELOAD=([^\\0]*)/.exec(env)||[])[1]||null})}
console.log(JSON.stringify({gw,gwHasKey:genv.includes("OC_ANTHROPIC_KEY="),gwHasPassword:!!pw,secrets:secrets.length,rows}))`;
    const r = await exec(["node", "-e", probe, KEY, GW], 60_000);
    let j = null;
    try {
      j = JSON.parse((r.stdout ?? "").trim().split("\n").pop());
    } catch {}
    const rows = j?.rows ?? [];
    return emit("m31", {
      exec: { ok: r.ok, exit: r.exitCode, err: (r.stderr ?? r.error ?? "").slice(0, 300) },
      gateway: j
        ? { pid: j.gw, hasKey: j.gwHasKey, hasPassword: j.gwHasPassword, secretsChecked: j.secrets }
        : null,
      children: rows,
      checks: {
        probeRan: !!j,
        children: rows.length >= 1,
        gatewayKeepsKey: !!j?.gwHasKey,
        noUid1000Read: rows.every((x) => x.uid1000 === "DENIED"),
        noSecretValue: rows.every((x) => x.leaks === 0),
        noSecretName: rows.every((x) => x.bad.length === 0),
        nodump: rows.every((x) => /nodump\.so/.test(x.preload ?? "")),
      },
    });
  },

  async a1() {
    await running();
    const t0 = now();
    const DB = "/home/node/.openclaw/state/openclaw.sqlite";
    const INSERT = `const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync(process.argv[1]);c.exec("PRAGMA busy_timeout=5000");
const cols=c.prepare("PRAGMA table_info(cron_jobs)").all();const v={};for(const k of cols){if(k.notnull&&k.dflt_value===null)v[k.name]=k.type.toUpperCase().includes("INT")?0:"m4"}
Object.assign(v,{store_key:"/var/lib/ocrt/stage-u/cron/jobs.json",job_id:"m4-orphan-live",enabled:1,job_json:JSON.stringify({id:"m4-orphan-live",schedule:{kind:"every",everyMs:1800000}}),state_json:JSON.stringify({nextRunAtMs:Date.now()-4.5*3600000})});
for(const k of Object.keys(v))if(!cols.some(x=>x.name===k))delete v[k];const ks=Object.keys(v);
c.prepare("INSERT INTO cron_jobs ("+ks.join(",")+") VALUES ("+ks.map(()=>"?").join(",")+")").run(...ks.map(k=>v[k]));console.log("ok")`;
    const LIST = `const {DatabaseSync}=require("node:sqlite");const c=new DatabaseSync(process.argv[1],{readOnly:true});console.log(JSON.stringify(c.prepare("SELECT store_key, job_id FROM cron_jobs").all()))`;
    const orphanCount = async () =>
      ((await ops("GET", "/ops/alerts")).json?.alerts ?? []).find((a) => a.class === "cron-orphan")?.count ??
      0;
    const alertsBefore = await orphanCount();
    const ins = await node1000(INSERT, [DB]);
    const before = JSON.parse((await node1000(LIST, [DB])).stdout?.trim() || "[]");
    const sr = await exec([
      "setpriv",
      "--reuid=1000",
      "--regid=1000",
      "--init-groups",
      "node",
      "/opt/ocrt/ocio/sleep-read.mjs",
      DB,
      String(now()),
    ]);
    let srj = {};
    try {
      srj = JSON.parse((sr.stdout ?? "").trim());
    } catch {}
    const rg = await exec(["node", "/opt/ocrt/ocsupctl.mjs", "restart-gateway"], 400_000);
    const gone = await waitFor(
      async () => {
        const rows = JSON.parse((await node1000(LIST, [DB])).stdout?.trim() || "[]");
        return rows.some((r) => r.job_id === "m4-orphan-live") ? null : rows;
      },
      180_000,
      5000,
    );
    const al = await alerts(t0 - 1000);
    const alertsAfter = await orphanCount();
    return emit("a1", {
      alertCount: [alertsBefore, alertsAfter],
      inserted: (ins.stdout ?? "").trim(),
      rowsBefore: before.length,
      rowsAfter: gone.v?.length ?? null,
      sleepReadNextWakeAtMs: srj.nextWakeAtMs ?? null,
      restartGateway: rg.ok,
      deletedAfterMs: gone.ms,
      alerts: al.map((a) => `${a.class ?? a.cls}:${(a.last_detail ?? a.detail ?? "").slice(0, 120)}`),
      checks: {
        inserted: (ins.stdout ?? "").includes("ok"),
        sleepReadNotPast: srj.ok === true && (srj.nextWakeAtMs === null || srj.nextWakeAtMs > now() - 60_000),
        orphanDeleted: !!gone.v,
        othersKept: gone.v ? gone.v.length === before.length - 1 : false,
        alert: alertsAfter > alertsBefore || al.some((a) => (a.class ?? a.cls) === "cron-orphan"),
      },
    });
  },

  async ws() {
    await running();
    const out = {};
    // (a) revoke → 1008 within wsCheckMs + margin.
    const a = await login();
    note("login a", { status: a.status, id: a.id, cookie: !!a.cookie });
    const wa = await openWs(a.cookie);
    note("ws a", { connect: wa.connect, closed: wa.closed, err: wa.err });
    const rvAt = now();
    const rv = await ops("POST", "/ops/auth/revoke", { id: a.id });
    const ca = await Promise.race([wa.done, sleep(60_000).then(() => null)]);
    note("ws a closed", { ca, rv: rv.status });
    out.revoke = {
      connect: !!wa.connect?.ok,
      revoke: rv.status,
      closed: ca,
      afterRevokeMs: ca ? ca.at - rvAt : null,
    };
    // (b) idle-close + latch: no frames; expect 1000 "idle" at uiIdleMs (+ check round).
    const b = await login();
    const wb = await openWs(b.cookie);
    note("ws b", { connect: wb.connect });
    const cb = await Promise.race([wb.done, sleep(240_000).then(() => null)]);
    note("ws b closed", cb);
    const upLatched = await upgradeStatus(b.cookie);
    const wsLatched = await openWs(b.cookie); // the real client: must not connect while latched
    note("upgrade while latched", { upLatched });
    const nav = { status: curlStatus(b.cookie) };
    const upAfterNav = await upgradeStatus(b.cookie);
    note("nav", { status: nav.status });
    const wb2 = await openWs(b.cookie);
    note("ws b2", { connect: wb2.connect, closed: wb2.closed, err: wb2.err });
    out.idle = {
      connect: !!wb.connect?.ok,
      closed: cb,
      openToCloseMs: cb && wb.openAt ? cb.at - wb.openAt : null,
      upgradeWhileLatched: upLatched,
      wsWhileLatched: {
        connect: wsLatched.connect ?? null,
        closed: wsLatched.closed,
        err: wsLatched.err ?? null,
      },
      navStatus: nav.status,
      upgradeAfterNav: upAfterNav,
      reconnectAfterNav: !!wb2.connect?.ok,
    };
    try {
      wb2.sock.close(1000);
    } catch {}
    // (c) 24 h cap (wsMaxAgeMs in the test timers): keep intent + write frames flowing; expect 1008 max age.
    const c = await login();
    const wc = await openWs(c.cookie);
    note("ws c", { connect: wc.connect });
    const tick = setInterval(() => {
      wc.send("presence.activity");
      wc.send("m4probe.update"); // unknown method, write verb: classed chat-or-write, gateway answers an error
    }, 20_000);
    const cc = await Promise.race([wc.done, sleep(420_000).then(() => null)]);
    clearInterval(tick);
    out.maxAge = {
      connect: !!wc.connect?.ok,
      closed: cc,
      openToCloseMs: cc && wc.openAt ? cc.at - wc.openAt : null,
    };
    return emit("ws", {
      ...out,
      checks: {
        revokeClosed1008: out.revoke.closed?.code === 1008,
        revokeWithin20s: (out.revoke.afterRevokeMs ?? 1e9) <= 20_000,
        idleClosed1000: out.idle.closed?.code === 1000 && /idle/.test(out.idle.closed?.reason ?? ""),
        latchedUpgrade503: out.idle.upgradeWhileLatched === 503 && !out.idle.wsWhileLatched.connect,
        navClearsLatch: out.idle.reconnectAfterNav,
        maxAge1008: out.maxAge.closed?.code === 1008 && /max age/.test(out.maxAge.closed?.reason ?? ""),
      },
    });
  },

  async rpo() {
    await running();
    const t0 = now();
    const s0 = await status();
    const gen0 = s0.runtime?.gen ?? s0.gen ?? null;
    const writes = [];
    const write = async (i) => {
      const at = now();
      const r = await node1000(
        `require("fs").writeFileSync("/home/node/.openclaw/workspace/m4-rpo-"+process.argv[1]+".md", "m4 rpo "+process.argv[1]+" "+Date.now()+"\\n")`,
        [String(i)],
      );
      writes.push({ i, at, ok: (r.exitCode ?? 1) === 0 });
    };
    let i = 0;
    let ck = null;
    const deadline = t0 + 15 * 60_000;
    // Write every 15 s until a checkpoint lands after ≥ 2 writes, then 4 more writes (after the checkpoint).
    while (now() < deadline) {
      await write(i++);
      const ev = await ring(t0);
      ck = ev.find((e) => e.src === "rt" && e.kind === "checkpoint" && e.at > (writes[1]?.at ?? Infinity));
      if (ck) break;
      await sleep(15_000);
    }
    for (let k = 0; k < 4 && ck; k++) {
      await sleep(15_000);
      await write(i++);
    }
    const killAt = now();
    const kill = await ops("POST", "/ops/fault", { name: "sigkill" });
    await sleep(5000);
    const up = await waitFor(
      async () => {
        const s = await status();
        const g = s.runtime?.gen ?? s.gen ?? null;
        return (s.runtime?.state ?? s.state) === "running" && g !== gen0 ? s : null;
      },
      600_000,
      5000,
    );
    const ls = await node1000(
      `console.log(JSON.stringify(require("fs").readdirSync("/home/node/.openclaw/workspace").filter(f=>f.startsWith("m4-rpo-"))))`,
    );
    let have = [];
    try {
      have = JSON.parse((ls.stdout ?? "").trim());
    } catch {}
    const kept = writes.map((w) => ({ ...w, kept: have.includes(`m4-rpo-${w.i}.md`) }));
    const ckAt = ck?.at ?? null;
    const lostWritten = kept.filter((w) => !w.kept);
    const newestKept = Math.max(0, ...kept.filter((w) => w.kept).map((w) => w.at));
    const ev = await ring(t0);
    const startRow = ev.filter((e) => e.src === "ctl" && /started|boot/.test(e.kind)).slice(-3);
    return emit("rpo", {
      checkpoint: ck ? { at: iso(ck.at), ...ck.d } : null,
      killAt: iso(killAt),
      kill: kill.status,
      killToRunningMs: up.ms + 5000,
      genBefore: gen0,
      genAfter: up.v?.runtime?.gen ?? up.v?.gen ?? null,
      writes: kept.map((w) => `${w.i}@${w.at - t0}:${w.kept ? "kept" : "lost"}`),
      bulkLossWindowMs: newestKept ? killAt - newestKept : null,
      checkpointAgeAtKillMs: ckAt ? killAt - ckAt : null,
      startRows: startRow.map((e) => `${e.kind} ${JSON.stringify(e.d).slice(0, 160)}`),
      checks: {
        checkpointTaken: !!ck,
        restarted: !!up.v,
        writesBeforeCheckpointKept: kept.filter((w) => ckAt && w.at < ckAt - 2000).every((w) => w.kept),
        lossBoundedByCheckpoint: lostWritten.every((w) => !ckAt || w.at > ckAt - 2000),
      },
    });
  },

  async cost() {
    const s = await status();
    return emit("cost", { meter: s.cost ?? s.meter ?? null, checks: {} });
  },
};

const step = process.argv[2];
if (!steps[step]) {
  console.error(`usage: node m4-fix.mjs <${Object.keys(steps).join("|")}>`);
  process.exit(2);
}
const ok = await steps[step]();
process.exit(ok ? 0 : 1);
