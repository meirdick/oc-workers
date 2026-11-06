// Control DO test world: ControlApi on node:sqlite (FakeStorage), fake R2, fake clock, fake Runtime DO, fake sink.

import { DEFAULT_TIMERS, TEST_TIMERS, type Timers } from "../../src/core/timers";
import type { BucketLike, RtState, RtStatusLite, RuntimeRpc, WakeReason } from "../../src/core/types";
import { ControlApi } from "../../src/ctl/api";
import { type Ctx, DEFAULT_SETTINGS, mergeSettings, type Settings } from "../../src/ctl/ctx";
import { Db } from "../../src/ctl/sql";
import { FakeR2 } from "../harness/r2";
import { FakeStorage } from "../harness/storage";

export const T0 = Date.parse("2026-11-01T10:00:00Z");

export type DeliverFn = (req: {
  path: string;
  body: string;
  headers: Record<string, string>;
  okIsDurable?: boolean;
}) => { status: number; durable: boolean } | Promise<{ status: number; durable: boolean }>;

/** Fake Runtime DO (Control DO → Runtime RPC). One per epoch. */
export class FakeRt implements RuntimeRpc {
  state: RtState = "new";
  wakes: WakeReason[] = [];
  ensures = 0;
  delivered: {
    path: string;
    body: string;
    headers: Record<string, string>;
    okIsDurable?: boolean;
    quiet?: boolean;
  }[] = [];
  deliverFn: DeliverFn = () => ({ status: 200, durable: true });
  retireResult: { settled: boolean; lastHbAt?: number } = { settled: true };
  retired = false;
  failNext: string | null = null;
  constructor(readonly epoch: number) {}
  private maybeFail() {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw new Error(e);
    }
  }
  async requestWake(reason: WakeReason) {
    this.maybeFail();
    this.wakes.push(reason);
    if (this.state === "asleep" || this.state === "new") this.state = "starting";
    return { state: this.state, action: "start" };
  }
  async ensure() {
    this.maybeFail();
    this.ensures++;
    return { state: this.state };
  }
  async status(): Promise<RtStatusLite> {
    return { state: this.state, desired: "running", gen: 1, blockers: [] };
  }
  async deliver(req: { path: string; body: string; headers: Record<string, string>; okIsDurable?: boolean }) {
    this.delivered.push(req);
    return this.deliverFn(req);
  }
  async sleepNow(o: { force: boolean }) {
    return { ok: true, reason: o.force ? "forced" : "gate", opId: "sleep-1" };
  }
  async ownerStart() {
    this.state = "starting";
    return { ok: true, state: this.state };
  }
  async ownerStop() {
    this.state = "stopped";
    return { ok: true, state: this.state };
  }
  async retire() {
    this.retired = true;
    return this.retireResult;
  }
}

export interface WorldOpts {
  timers?: Partial<Timers>;
  real?: boolean;
  settings?: Partial<Settings>;
  alertUrl?: string | null;
  inst?: string;
  storage?: FakeStorage;
  r2?: FakeR2;
  clock?: { t: number };
}

export function world(o: WorldOpts = {}) {
  const clock = o.clock ?? { t: T0 };
  const storage = o.storage ?? new FakeStorage();
  const r2 = o.r2 ?? new FakeR2(() => clock.t);
  const rts = new Map<number, FakeRt>();
  const rtFor = (n: number) => {
    let r = rts.get(n);
    if (!r) {
      r = new FakeRt(n);
      rts.set(n, r);
    }
    return r;
  };
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  let sinkStatus = 200;
  let settings: Settings = mergeSettings(DEFAULT_SETTINGS, o.settings ?? {});
  const timers: Timers = { ...(o.real ? DEFAULT_TIMERS : TEST_TIMERS), ...(o.timers ?? {}) };
  const ctx: Ctx = {
    db: new Db(storage as never),
    inst: o.inst ?? "t1",
    now: () => clock.t,
    timers,
    bucket: r2 as unknown as BucketLike,
    rt: (n) => rtFor(n),
    settings: () => settings,
    secrets: {
      webhookSecret: "wh-secret-1",
      alertUrl: o.alertUrl === null ? undefined : (o.alertUrl ?? "https://ntfy.example/topic"),
      alertToken: "tk",
    },
    test: true,
    instance: undefined,
    codeVersion: "cv-test",
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({
        url: String(url),
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: String(init.body),
      });
      return new Response("ok", { status: sinkStatus });
    }) as unknown as typeof fetch,
  };
  const api = new ControlApi(ctx);
  return {
    api,
    core: api.core,
    ledger: api.ledger,
    ctx,
    db: ctx.db,
    storage,
    r2,
    clock,
    rt: rtFor,
    sent,
    setSink(status: number) {
      sinkStatus = status;
    },
    setSettings(s: Partial<Settings>) {
      settings = mergeSettings(settings, s);
    },
    advance(ms: number) {
      clock.t += ms;
    },
    /** A second Control DO instance over the same storage (DO restart). */
    restart() {
      return world({ ...o, storage, r2, clock });
    },
    install(digest = "sha256:img1") {
      return api.core.install({ imageKey: "oc", digest, codeVersion: "cv-test" });
    },
  };
}

export type World = ReturnType<typeof world>;

/** Telegram update body. */
export function tg(updateId: number, fromId = 111, chatId = fromId, text = "hi"): string {
  return JSON.stringify({
    update_id: updateId,
    message: { message_id: updateId, from: { id: fromId }, chat: { id: chatId }, text },
  });
}

let opSeq = 0;
export const opId = (p = "op") => `${p}-${++opSeq}`;

/** Boot a gen to `complete` with DB uploads through the ledger (as ReplicaGate would). */
export async function bootComplete(
  w: World,
  o: {
    reason?: string;
    epoch?: number;
    dbs?: string[];
    maxTxid?: number;
    ladder?: 1 | 2 | 3 | 4 | "slow";
  } = {},
) {
  const epoch = o.epoch ?? 1;
  const r = await w.api.beginBoot({
    epoch,
    mode: "prod",
    opId: opId("start"),
    reason: o.reason ?? "user",
    ladder: o.ladder,
  });
  const dbs = o.dbs ?? ["state/openclaw.sqlite"];
  w.api.gateCall("event", [r.gen, { kind: "replica-set", detail: { dbs } }]);
  for (const db of dbs) {
    const key = `r/${w.ctx.inst}/g${r.gen}/${db}/0000/${(1).toString(16).padStart(16, "0")}-${(o.maxTxid ?? 5).toString(16).padStart(16, "0")}.ltx`;
    w.ledger.recordUpload({ key, bytes: 1000 });
  }
  await w.api.onStarted({
    epoch,
    gen: r.gen,
    opId: "x",
    reason: o.reason ?? "user",
    digest: r.digest,
    wakeAt: w.clock.t,
    aliveMs: 1,
    startupzMs: 10,
  });
  return r;
}
