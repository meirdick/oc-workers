// SandboxSession Durable Object (docs/12 §3): `sb:<inst>`, one per install, with its own container image
// (image/sandbox). Thin shell over SandboxCore; reached only from the Worker (SandboxGate, Runtime DO sleep op,
// /ops/sandbox), never from the internet.

import { DurableObject } from "cloudflare:workers";
import { DirectoryBackup, type DirectoryBackupRecord } from "@cloudflare/sandbox";
import { ctlName, type Env } from "../core/types";
import { gatePort } from "../gates/ledger";
import { MAX_S_HEADER } from "../gates/sbx";
import { type BackupRecord, SandboxCore, SbxError, type SleepReason } from "./core";
import { mergeCommand } from "./import";
import { decodeFrames, readHead } from "./wire";

/** R2 key prefix of the workspace backups in the install bucket. */
export const backupPrefix = (inst: string) => `sbx/${inst}/`;

export class SandboxSession extends DurableObject<Env> {
  private core: SandboxCore | null = null;
  private ready: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const name = ctx.id.name ?? "";
    const inst = name.startsWith("sb:") ? name.slice(3) : "";
    const c = ctx.container;
    if (!inst || !c) return;
    const exp = ctx.exports as unknown as Record<string, unknown>;
    const backups = new DirectoryBackup(c, exp.DirectoryBackupGateway as never, {
      binding: "BUCKET",
      prefix: backupPrefix(inst),
    });
    const stub = env.CONTROL.getByName(ctlName(inst)) as unknown as {
      gateCall(m: string, a: unknown[]): Promise<unknown>;
    };
    const ctl = gatePort((m, a) => stub.gateCall(m, a));
    const cc = c as Container;
    this.core = new SandboxCore({
      container: {
        get running() {
          return cc.running;
        },
        images: () => cc.images,
        start: (o) => cc.start(o as ContainerStartupOptions),
        exec: (cmd, o) => cc.exec(cmd, { ...o, stdout: "pipe", stderr: "pipe" }) as never,
        destroy: (r) => cc.destroy(r),
        setInactivityTimeout: (ms) => cc.setInactivityTimeout(ms),
      },
      backups: {
        backup: (o) => backups.backup(o) as Promise<BackupRecord>,
        restore: (r) => backups.restore(r as DirectoryBackupRecord),
        delete: (r) => backups.delete(r as DirectoryBackupRecord),
      },
      ctl: {
        capAdd: (v, n) => ctl.capAdd(v, n),
        capCheck: (v) => ctl.capCheck(v),
        ring: (s, k, x) => ctl.ring(s, k, x),
        alert: (cls, sev, detail) => ctl.alert(cls, sev, detail),
      },
      store: { get: (k) => ctx.storage.get(k), put: (k, v) => ctx.storage.put(k, v) },
      alarm: { set: (at) => ctx.storage.setAlarm(at), delete: () => ctx.storage.deleteAlarm() },
      now: Date.now,
    });
    const core = this.core;
    this.ready = ctx.blockConcurrencyWhile(() => core.init());
  }

  private async c(): Promise<SandboxCore> {
    await this.ready;
    if (!this.core) throw new Error("SandboxSession: bad name or no container");
    return this.core;
  }

  /** POST /exec from SandboxGate only. */
  override async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname !== "/exec" || req.method !== "POST" || !req.body)
      return Response.json({ error: "not found" }, { status: 404 });
    const core = await this.c();
    let head: Awaited<ReturnType<typeof readHead>>;
    try {
      head = await readHead(req.body);
    } catch (e) {
      return Response.json({ error: String(e instanceof Error ? e.message : e) }, { status: 400 });
    }
    try {
      const maxS = Number(req.headers.get(MAX_S_HEADER) ?? 0) || 1;
      const r = await core.exec(head.head.cmd, head.rest, maxS);
      this.ctx.waitUntil(r.done);
      return new Response(r.body, { headers: { "content-type": "application/x-ochost-sbx" } });
    } catch (e) {
      const status = e instanceof SbxError ? e.status : 502;
      return Response.json({ error: String(e instanceof Error ? e.message : e).slice(0, 300) }, { status });
    }
  }

  async sleep(reason: SleepReason) {
    return (await this.c()).sleep(reason);
  }

  async status() {
    return (await this.c()).status();
  }

  /**
   * `ochost import` (sbx/import.ts): merge the bundle at `key` into every seeded remote workspace. Wakes the sandbox
   * (restore first), runs one exec of at most 10 min. Returns the per-workspace counts or {ok:false, why}.
   */
  async importBundle(a: { key: string; id: string; overwrite: string[]; remove: string[] }) {
    const core = await this.c();
    const o = await this.env.BUCKET.get(a.key);
    if (!o) return { ok: false, why: "bundle missing" };
    const r = await core.exec(
      mergeCommand({ id: a.id, overwrite: a.overwrite, remove: a.remove }),
      o.body,
      600,
    );
    const buf = new Uint8Array(await new Response(r.body).arrayBuffer());
    await r.done;
    const f = decodeFrames(buf);
    try {
      const j = JSON.parse(f.stdout.trim().split("\n").pop() ?? "");
      if (f.code === 0 && j?.ok) return j as { ok: true; targets: Record<string, unknown>[] };
    } catch {}
    return { ok: false, why: `exit ${f.code}: ${f.stderr.slice(-300)}` };
  }

  override async alarm(): Promise<void> {
    await (await this.c()).alarm();
  }
}
