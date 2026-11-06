// SandboxSession state machine (sbx/core.ts) with a fake container, fake DirectoryBackup and the real ledger
// budgets (Control DO SQLite). The container's "workspace" is one string, so persistence across sleep is visible.
import { describe, expect, it } from "vitest";
import {
  type BackupRecord,
  KEEP_BACKUPS,
  SandboxCore,
  type SbxContainer,
  type SbxTimers,
  WORKSPACE,
} from "../../src/sbx/core";
import { decodeFrames, encodeRequest, readHead } from "../../src/sbx/wire";
import { World } from "../gates/harness";

const MIN = 60_000;
const HOUR = 3_600_000;
const enc = new TextEncoder();

const stream = (s: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      if (s) c.enqueue(enc.encode(s));
      c.close();
    },
  });
async function readAll(s: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!s) return "";
  return new Response(s).text();
}

type Script = (
  sh: string,
  stdin: string,
  c: FakeSbx,
) => { out?: string; err?: string; code?: number; ms?: number };

class FakeSbx implements SbxContainer {
  running = false;
  ws: string | null = null;
  calls: string[] = [];
  argv: string[][] = [];
  starts: Record<string, unknown>[] = [];
  /** Pending long commands: release() ends one. */
  holds: (() => void)[] = [];
  constructor(
    private readonly clock: { t: number },
    public script: Script = () => ({}),
  ) {}
  images() {
    return { sbx: "registry.cloudflare.com/x/sbx@sha256:1" };
  }
  start(o: Record<string, unknown>) {
    if (this.running) throw new Error("already running");
    this.running = true;
    this.ws = null; // a new instance has an empty disk
    this.starts.push(o);
    this.calls.push("start");
  }
  async exec(cmd: string[], o: { stdin?: ReadableStream<Uint8Array> }) {
    if (!this.running) throw new Error("not running");
    this.argv.push(cmd);
    if (cmd[0] === "mkdir") {
      this.ws = this.ws ?? "";
      return { stdout: stream(""), stderr: stream(""), exitCode: Promise.resolve(0) };
    }
    const sh = cmd[cmd.length - 1] as string;
    const stdin = await readAll(o.stdin);
    const r = this.script(sh, stdin, this);
    let code = Promise.resolve(r.code ?? 0);
    if (r.ms === -1) code = new Promise<number>((res) => this.holds.push(() => res(r.code ?? 0)));
    else this.clock.t += r.ms ?? 0;
    return { stdout: stream(r.out ?? ""), stderr: stream(r.err ?? ""), exitCode: code };
  }
  async destroy() {
    this.running = false;
    this.calls.push("destroy");
  }
  async setInactivityTimeout(ms: number) {
    this.calls.push(`inactivity:${ms}`);
  }
}

/** `set:<v>` writes the workspace, `get` prints it, anything else echoes stdin. */
const wsScript: Script = (sh, stdin, c) => {
  if (sh.startsWith("set:")) {
    c.ws = sh.slice(4);
    return {};
  }
  if (sh === "get") return { out: c.ws ?? "<none>" };
  return { out: stdin };
};

class FakeBackups {
  objects = new Map<string, string>();
  fail = { backup: 0, restore: new Set<string>() };
  n = 0;
  constructor(private readonly c: FakeSbx) {}
  async backup(o: { dir: string }): Promise<BackupRecord> {
    if (this.fail.backup > 0) {
      this.fail.backup--;
      throw new Error("BACKUP_TRANSFER 500");
    }
    const id = `b${++this.n}`;
    this.objects.set(id, this.c.ws ?? "");
    return { id, dir: o.dir, size: (this.c.ws ?? "").length, sha256: "0".repeat(64), format: "tar+zstd/1" };
  }
  async restore(r: BackupRecord) {
    if (this.fail.restore.has(r.id) || !this.objects.has(r.id)) throw new Error("BACKUP_INTEGRITY");
    this.c.ws = this.objects.get(r.id) as string;
  }
  async delete(r: BackupRecord) {
    this.objects.delete(r.id);
  }
}

function setup(o: { script?: Script; timers?: Partial<SbxTimers>; limits?: Record<string, number> } = {}) {
  const w = new World();
  if (o.limits) w.ledger.capsSet(o.limits);
  const c = new FakeSbx(w.clock, o.script ?? wsScript);
  const b = new FakeBackups(c);
  const kv = new Map<string, unknown>();
  const alarm = { at: null as number | null };
  const deps = {
    container: c,
    backups: b,
    ctl: {
      capAdd: async (v: never, n: number) => w.ledger.capAdd(v, n),
      capCheck: async (v: never) => w.ledger.capCheck(v),
      ring: async (s: string, k: string, d?: unknown) => w.ledger.ring(s, k, d),
      alert: async (cls: string, sev: "info" | "warn" | "high", d?: string) => w.ledger.alert(cls, sev, d),
    },
    store: {
      get: async <T>(k: string) => structuredClone(kv.get(k)) as T | undefined,
      put: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)),
    },
    alarm: {
      set: (at: number) => {
        alarm.at = at;
      },
      delete: () => {
        alarm.at = null;
      },
    },
    now: w.now,
    timers: o.timers,
  };
  const core = new SandboxCore(deps);
  /** A restarted DO: a new core over the same storage and container. */
  const restart = async () => {
    const n = new SandboxCore(deps);
    await n.init();
    return n;
  };
  const run = async (sc: SandboxCore, cmd: string, stdin = "", maxS = 7200) => {
    const r = await sc.exec(cmd, stream(stdin), maxS);
    const bytes = new Uint8Array(await new Response(r.body).arrayBuffer());
    await r.done;
    return decodeFrames(bytes);
  };
  const used = (v: "exec" | "sandbox") => w.ledger.capsView().verbs[v].used;
  const alerts = () =>
    w.sql<{ class: string; severity: string }>("SELECT class, severity FROM alerts ORDER BY class");
  /** Fire alarms until `ms` has passed. As on a DO, a fired alarm is cleared unless the handler sets it again. */
  const tickFor = async (sc: SandboxCore, ms: number) => {
    const end = w.clock.t + ms;
    while (alarm.at !== null && alarm.at <= end) {
      w.clock.t = alarm.at;
      alarm.at = null;
      await sc.alarm();
    }
    w.clock.t = end;
  };
  return { w, c, b, core, kv, alarm, run, used, alerts, tickFor, restart };
}

describe("wire", () => {
  it("header and stdin split at any chunk boundary; bad headers refuse", async () => {
    const body = encodeRequest("echo hi", enc.encode("STDIN-BYTES"));
    for (const cut of [1, 3, 4, 9, body.length - 1]) {
      const s = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(body.slice(0, cut));
          c.enqueue(body.slice(cut));
          c.close();
        },
      });
      const r = await readHead(s);
      expect(r.head.cmd).toBe("echo hi");
      expect(await readAll(r.rest)).toBe("STDIN-BYTES");
    }
    const bad = new Uint8Array(8);
    new DataView(bad.buffer).setUint32(0, 0);
    await expect(readHead(stream("\u0000\u0000"))).rejects.toThrow(/short/);
    await expect(
      readHead(
        new ReadableStream({
          start(c) {
            c.enqueue(bad);
            c.close();
          },
        }),
      ),
    ).rejects.toThrow(/header length/);
    await expect(readHead(stream(String.fromCharCode(0, 0, 0, 2, 123, 125)))).rejects.toThrow(/bad header/);
  });
});

describe("wake and exec", () => {
  it("first exec wakes: one start (no internet, sleep infinity), empty workspace, command under timeout", async () => {
    const s = setup({ script: (sh) => ({ out: `out:${sh}`, err: "warn\n", code: 3, ms: 2500 }) });
    const r = await s.run(s.core, "ls -la", "", 99_999);
    expect(r).toEqual({ stdout: "out:ls -la", stderr: "warn\n", code: 3 });
    expect(s.c.starts).toEqual([
      {
        image: "registry.cloudflare.com/x/sbx@sha256:1",
        enableInternet: false,
        instance: "basic",
        entrypoint: ["sleep", "infinity"],
      },
    ]);
    expect(s.c.argv[0]).toEqual(["mkdir", "-p", WORKSPACE]);
    // The per-command limit is the smaller of the budget left and maxExecS (1800).
    expect(s.c.argv[1]).toEqual(["timeout", "-k", "5", "1800", "/bin/sh", "-c", "ls -la"]);
    expect(s.c.calls).toContain("inactivity:900000");
    expect(s.used("exec")).toBe(3); // 2.5 s → 3
    expect(s.core.status()).toMatchObject({ state: "running", wakes: 1, inflight: 0 });
    expect(s.alarm.at).toBe(s.w.clock.t - 2500 + MIN);
  });

  it("budget left under maxExecS becomes the limit; stdin reaches the command", async () => {
    const s = setup();
    const r = await s.run(s.core, "cat", "payload", 42.9);
    expect(r.stdout).toBe("payload");
    expect(s.c.argv[1]?.slice(0, 4)).toEqual(["timeout", "-k", "5", "42"]);
  });

  it("concurrent first commands start one container", async () => {
    const s = setup();
    const rs = await Promise.all([s.run(s.core, "a"), s.run(s.core, "b"), s.run(s.core, "c")]);
    expect(rs.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(s.c.starts.length).toBe(1);
  });

  it("a start that throws (no capacity) answers 503 and stays asleep", async () => {
    const s = setup();
    s.c.start = () => {
      throw new Error("no container instance available");
    };
    await expect(s.core.exec("x", undefined, 10)).rejects.toMatchObject({ status: 503 });
    expect(s.core.status().state).toBe("asleep");
  });
});

describe("sleep and persistence", () => {
  it("idle: the alarm sleeps after idleMs with a backup; the next exec restores the edits", async () => {
    const s = setup();
    await s.run(s.core, "set:v1");
    await s.tickFor(s.core, 9 * MIN);
    expect(s.core.status().state).toBe("running");
    await s.tickFor(s.core, 2 * MIN);
    expect(s.core.status()).toMatchObject({ state: "asleep", lastSleep: "idle" });
    expect(s.c.calls.filter((x) => x === "destroy").length).toBe(1);
    expect(s.alarm.at).toBeNull();
    // Hours charged: 10 min running (slept on the 10-min tick).
    expect(s.used("sandbox")).toBeCloseTo(10 / 60, 6);
    const r = await s.run(s.core, "get");
    expect(r.stdout).toBe("v1");
    expect(s.c.starts.length).toBe(2);
  });

  it("a running command keeps the sandbox up past idle; it sleeps after the command ends", async () => {
    const s = setup({ script: (sh) => (sh === "long" ? { ms: -1 } : {}) });
    const p = s.core.exec("long", undefined, 7200);
    const r = await p;
    await s.tickFor(s.core, 30 * MIN);
    expect(s.core.status()).toMatchObject({ state: "running", inflight: 1 });
    s.c.holds.shift()?.();
    await new Response(r.body).arrayBuffer();
    await r.done;
    await s.tickFor(s.core, 11 * MIN);
    expect(s.core.status().state).toBe("asleep");
  });

  it("install sleep keeps the newest KEEP_BACKUPS records and deletes older objects", async () => {
    const s = setup();
    for (const v of ["v1", "v2", "v3"]) {
      await s.run(s.core, `set:${v}`);
      expect(await s.core.sleep("install")).toEqual({ slept: true });
    }
    expect(s.core.status().backups.map((b) => b.id)).toEqual(["b2", "b3"]);
    expect([...s.b.objects.keys()]).toEqual(["b2", "b3"]);
    expect(KEEP_BACKUPS).toBe(2);
    expect((await s.run(s.core, "get")).stdout).toBe("v3");
    expect(await s.core.sleep("install")).toEqual({ slept: true });
    expect(await s.core.sleep("install")).toEqual({ slept: false, why: "asleep" });
  });

  it("a bad newest backup falls back to the older one; none restorable → alert high, empty workspace", async () => {
    const s = setup();
    await s.run(s.core, "set:old");
    await s.core.sleep("install");
    await s.run(s.core, "set:new");
    await s.core.sleep("install");
    s.b.fail.restore.add("b2");
    expect((await s.run(s.core, "get")).stdout).toBe("old");
    expect(s.core.status().backups.map((b) => b.id)).toEqual(["b1"]);
    expect(s.alerts()).toEqual([]);
    await s.core.sleep("owner");
    s.b.fail.restore = new Set(["b1", "b3"]);
    expect((await s.run(s.core, "get")).stdout).toBe("");
    expect(s.alerts()).toEqual([{ class: "sbx-restore-failed", severity: "high" }]);
  });

  it("failed backups keep the container up; the 3rd forced attempt stops it with sbx-workspace-lost", async () => {
    const s = setup();
    await s.run(s.core, "set:v");
    s.b.fail.backup = 3;
    expect(await s.core.sleep("install")).toEqual({ slept: false, why: "backup-failed" });
    expect(await s.core.sleep("install")).toEqual({ slept: false, why: "backup-failed" });
    expect(s.c.running).toBe(true);
    expect(await s.core.sleep("install")).toEqual({ slept: true });
    expect(s.c.running).toBe(false);
    expect(s.alerts()).toEqual([{ class: "sbx-workspace-lost", severity: "high" }]);
  });

  it("periodic backup of a used workspace every backupEveryMs bounds loss on a platform stop", async () => {
    const s = setup({ timers: { idleMs: 10 * HOUR } });
    await s.run(s.core, "set:a");
    await s.tickFor(s.core, 31 * MIN);
    expect(s.core.status().backups.length).toBe(1);
    await s.run(s.core, "set:b");
    s.c.running = false; // platform stop, no backup of "b"
    await s.tickFor(s.core, MIN);
    expect(s.core.status()).toMatchObject({ state: "asleep", lastSleep: "lost" });
    expect(s.alerts()).toEqual([{ class: "sbx-lost", severity: "warn" }]);
    expect((await s.run(s.core, "get")).stdout).toBe("a");
  });
});

describe("budgets", () => {
  it("sandbox hours: warn at 80%, high at 100%, then the alarm sleeps it (budget)", async () => {
    const s = setup({ limits: { sandbox: 0.5 }, timers: { idleMs: 10 * HOUR, backupEveryMs: 10 * HOUR } });
    await s.run(s.core, "set:x");
    await s.tickFor(s.core, 23 * MIN); // 77%
    expect(s.alerts()).toEqual([]);
    await s.tickFor(s.core, 2 * MIN); // 83% (24 ticks of 1/60 h sum just under 0.4 in floats)
    expect(s.alerts()).toEqual([{ class: "cap-sandbox-80", severity: "warn" }]);
    expect(s.core.status().state).toBe("running");
    await s.tickFor(s.core, 6 * MIN); // 31 min > 0.5 h (float sums cross the limit one tick late at most)
    expect(s.alerts().map((a) => a.class)).toEqual(["cap-sandbox-100", "cap-sandbox-80"]);
    expect(s.core.status()).toMatchObject({ state: "asleep", lastSleep: "budget" });
    expect(s.b.objects.size).toBe(1); // backed up before the stop
    expect(s.used("sandbox")).toBeCloseTo(31 / 60, 6);
  });

  it("exec seconds charge per command, at least 1 s, alerts at 80%", async () => {
    const s = setup({ limits: { exec: 10 }, script: (sh) => ({ ms: Number(sh) }) });
    await s.run(s.core, "10"); // 0.01 s → 1
    await s.run(s.core, "6200"); // → 7, total 8 = 80%
    expect(s.used("exec")).toBe(8);
    expect(s.alerts()).toEqual([{ class: "cap-exec-80", severity: "warn" }]);
  });
});

describe("DO restart", () => {
  it("running container: timeout set again, alarm armed; stopped container: lost, hours capped", async () => {
    const s = setup();
    await s.run(s.core, "set:v");
    s.c.calls = [];
    s.alarm.at = null;
    const n = await s.restart();
    expect(s.c.calls).toEqual(["inactivity:900000"]);
    expect(s.alarm.at).not.toBeNull();
    expect(n.status().state).toBe("running");
    // The container stops while the DO is gone for 2 h: charged up to lastUse + inactivity (15 min), not 2 h.
    s.c.running = false;
    s.w.clock.t += 2 * HOUR;
    const n2 = await s.restart();
    expect(n2.status()).toMatchObject({ state: "asleep", lastSleep: "lost" });
    expect(s.used("sandbox")).toBeCloseTo(0.25, 6);
  });
});
