// Fake /ops server for the ops command tests: a real HTTP server on 127.0.0.1 with the Worker's auth rule
// (wrong or missing bearer → 404) and response shapes from worker/src/ctl/control.ts and ingress/routes.ts.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultsFlat, expand, flatten, validateDoc } from "../../worker/src/core/tunables.ts";
import { runOps } from "../src/ops-commands.ts";
import type { OpsCtx, Runner, RunResult } from "../src/ops-lib.ts";

export const T0 = Date.parse("2026-11-01T12:00:00Z");
export const OWNER = "a".repeat(64);

export interface Req {
  method: string;
  path: string;
  auth: string;
  body: any;
}

export type Handler = (r: Req) => { status: number; body: unknown } | undefined;

export function statusBody(over: Record<string, unknown> = {}) {
  return {
    inst: "a1b2c3",
    codeVersion: "v-test-1",
    initialized: true,
    ctlState: "ok",
    epoch: { n: 3, imageKey: "oc", digest: "sha256:0123456789abcdef0123", status: "active" },
    state: "asleep",
    degraded: false,
    ladder: { level: 0 },
    blockers: [],
    gen: {
      gen: 42,
      state: "complete",
      mode: "prod",
      reason: "wake:webhook",
      plan: { rootfs: "snapshot", snapshotId: "s-9" },
    },
    chainLength: 4,
    inbox: { pending: 0, held: 1, accepted: 3, dead: 0 },
    tier: "normal",
    rpo: "ok",
    wake: {
      spend24Usd: 0.31,
      awakeS24: 9400,
      sleeps24: 20,
      monthUsd: 9.3,
      alwaysOnMonthUsd: 47.6,
      savedPct: 80,
      wakes24: 20,
    },
    costGuard: { holding: false, spend24: 0.31, always24: 1.58, cycle: 0.006 },
    alerts: [],
    rt: {
      hb: { lastActivityAt: T0 - 25 * 60_000, rpo: "ok" },
      sleep: { wakeAt: T0 + 90 * 60_000, snapshotId: "s-10" },
    },
    ...over,
  };
}

export class FakeOps {
  server!: Server;
  url = "";
  token = OWNER;
  ciToken = "";
  reqs: Req[] = [];
  routes: Handler[] = [];
  /** A request this returns true for gets its socket closed with no answer (client: "fetch failed"). */
  drop: ((r: Req) => boolean) | null = null;
  status = statusBody();
  /** Fake settings document: flat dotted keys, versioned like the Worker's (ctl/settings.ts). */
  settings: Record<string, unknown> = {};
  settingsVer = 0;
  ring: { id: number; at: number; src: string; kind: string; detail: string | null }[] = [];

  async start(): Promise<this> {
    this.server = createServer(async (req, res) => {
      const body = await readBody(req);
      const u = new URL(req.url ?? "/", "http://x");
      const r: Req = {
        method: req.method ?? "GET",
        path: u.pathname + u.search,
        auth: req.headers.authorization ?? "",
        body,
      };
      this.reqs.push(r);
      if (this.drop?.(r)) {
        req.socket.destroy();
        return;
      }
      const out = this.handle(r);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
    await new Promise<void>((ok) => this.server.listen(0, "127.0.0.1", ok));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((ok) => this.server.close(() => ok()));
  }

  handle(r: Req): { status: number; body: unknown } {
    const nf = { status: 404, body: { error: "not found" } };
    const bearer = r.auth.replace(/^Bearer\s+/i, "");
    const role = bearer === this.token ? "owner" : this.ciToken && bearer === this.ciToken ? "ci" : null;
    if (!role) return nf;
    if (role === "ci" && !/^\/ops\/(status|ci)/.test(r.path)) return nf;
    for (const h of this.routes) {
      const x = h(r);
      if (x) return x;
    }
    const p = r.path.split("?")[0];
    if (r.method === "GET" && p === "/ops/status") return { status: 200, body: this.status };
    if (r.method === "GET" && p === "/ops/logs") {
      const lim = Number(new URL(r.path, "http://x").searchParams.get("limit") ?? 200);
      return { status: 200, body: { events: [...this.ring].sort((a, b) => b.id - a.id).slice(0, lim) } };
    }
    if (r.method === "POST" && p === "/ops/auth/code")
      return {
        status: 200,
        body: {
          code: "c0de".repeat(8),
          expiresAt: T0 + 600_000,
          url: `${this.url}/_ochost/login/${"c0de".repeat(8)}`,
        },
      };
    if (p === "/ops/settings") {
      if (r.method === "GET")
        return {
          status: 200,
          body: {
            ver: this.settingsVer,
            source: "cli",
            doc: expand(this.settings),
            effective: expand({ ...defaultsFlat(), ...this.settings }),
          },
        };
      const set = (r.body?.set ?? {}) as Record<string, unknown>;
      const next: Record<string, unknown> = r.body?.doc ? flatten(r.body.doc) : { ...this.settings };
      for (const [k, v] of Object.entries(set))
        if (v === null) delete next[k];
        else next[k] = v;
      const bad = validateDoc(expand(next));
      if (bad.length) return { status: 400, body: { error: bad[0] } };
      const changed = JSON.stringify(next) !== JSON.stringify(this.settings);
      this.settings = next;
      if (changed) this.settingsVer++;
      return { status: 200, body: { ok: true, ver: this.settingsVer, changed } };
    }
    if (r.method === "GET" && p === "/ops/config") return { status: 200, body: { versions: [] } };
    if (r.method === "GET" && p === "/ops/archive")
      return { status: 200, body: { newestAgeMs: null, archives: [], cfg: { everyMs: 6 * 3_600_000 } } };
    if (r.method === "GET" && p === "/ops/alerts") return { status: 200, body: { alerts: [], outbox: 0 } };
    if (r.method === "POST" && p === "/ops/ci") return { status: 200, body: { ok: true } };
    return nf;
  }

  calls(method: string, prefix: string): Req[] {
    return this.reqs.filter((r) => r.method === method && r.path.startsWith(prefix));
  }
}

async function readBody(req: IncomingMessage): Promise<any> {
  let s = "";
  for await (const c of req) s += c;
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** A temp install dir with state.json, the owner token (0600) and an oc-host.jsonc. */
export function installDir(url: string, opts: { token?: string; hostConfig?: string | null } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ochost-ops-test-"));
  mkdirSync(join(dir, ".oc-host"));
  writeFileSync(
    join(dir, ".oc-host", "state.json"),
    JSON.stringify({ url, inst: "a1b2c3", accountId: "0".repeat(32), name: "oc-m5-test" }),
  );
  writeFileSync(join(dir, ".oc-host", "control-token"), `${opts.token ?? OWNER}\n`, { mode: 0o600 });
  if (opts.hostConfig !== null)
    writeFileSync(
      join(dir, "oc-host.jsonc"),
      opts.hostConfig ??
        `{
  // Generated by ochost init.
  "name": "oc-m5-test",
  "sleep": {
    "mode": "auto",                        // auto | off
    "idleMinutes": 5,
    "proactive": "2h@08-22"
  },
  "alerts": { "channel": "none" }
}
`,
    );
  return dir;
}

export interface Recorded {
  cmd: string;
  args: string[];
  input?: string;
}

/** Fake process runner: records each call; `answer` decides the result. */
export function fakeRunner(answer: (c: Recorded) => Partial<RunResult> | undefined = () => undefined) {
  const calls: Recorded[] = [];
  const run: Runner = async (cmd, args, o = {}) => {
    const c = { cmd, args, input: o.input };
    calls.push(c);
    return { code: 0, stdout: "", stderr: "", ...(answer(c) ?? {}) };
  };
  return { run, calls };
}

/** Fake clock: sleep advances now. */
export function fakeClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Run one command against the fake server; capture stdout and stderr. */
export async function run(
  name: string,
  argv: string[],
  over: Partial<OpsCtx> = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const clock = fakeClock();
  const code = await runOps(
    name,
    argv,
    {
      env: {},
      now: clock.now,
      sleep: clock.sleep,
      nonInteractive: true,
      run: fakeRunner().run,
      prompts: { ask: async () => "n", askHidden: async () => "" },
      ...over,
    },
    {
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
    },
  );
  return { code, out, err };
}
