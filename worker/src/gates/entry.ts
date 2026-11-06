// Gate WorkerEntrypoints (spec §2.1). Reached only from containers through the intercepts that the Runtime DO
// registers with props (intercepts.ts). index.ts re-exports these classes.

import { WorkerEntrypoint } from "cloudflare:workers";
import { bucketName } from "../core/bucket";
import { ctlName, type Env, rtName } from "../core/types";
import { sbxName } from "../sbx/core";
import type { AiBinding } from "./ai";
import { type CapDeps, handleCapGate } from "./cap";
import { handleControlGate } from "./control";
import { handleLlm, handleTelegram, TelegramState } from "./fakes";
import { type GateCallName, gatePort } from "./ledger";
import { handleReplicaGate } from "./replica";
import { handleSandboxGate } from "./sbx";
import { handleTelegramGate } from "./telegram";
import { GateCache, type GateDeps, type GateProps, type RtGatePort } from "./types";

/** Control DO method the gates call: `gateCall(method, args)` → ledger.dispatchGateCall. */
interface CtlStub {
  gateCall(m: GateCallName, args: unknown[]): Promise<unknown>;
}

const cache = new GateCache();
const tg = new TelegramState();

/**
 * Bucket name Litestream puts in the path (plan.replica.bucket). Same rule as the Control DO plan (issue I-2):
 * OC_BUCKET, else OC_SETTINGS.bucket, else oc-host-<inst>.
 */
export const bucketNameOf = (env: Env, inst: string) => bucketName(env) ?? `oc-host-${inst}`;

export function gateDeps(env: Env, ctx: ExecutionContext, props: GateProps): GateDeps {
  const ctl = env.CONTROL.getByName(ctlName(props.inst)) as unknown as CtlStub;
  const rt = env.RUNTIME.getByName(rtName(props.inst, props.epoch)) as unknown as RtGatePort;
  return {
    props,
    ctl: gatePort((m, a) => ctl.gateCall(m, a)),
    rt,
    bucket: env.BUCKET,
    bucketName: bucketNameOf(env, props.inst),
    now: Date.now,
    cache,
    waitUntil: (p) => ctx.waitUntil(p),
  };
}

export class ControlGate extends WorkerEntrypoint<Env, GateProps> {
  override fetch(req: Request): Promise<Response> {
    return handleControlGate(req, gateDeps(this.env, this.ctx, this.ctx.props));
  }
}

export class ReplicaGate extends WorkerEntrypoint<Env, GateProps> {
  override fetch(req: Request): Promise<Response> {
    return handleReplicaGate(req, gateDeps(this.env, this.ctx, this.ctx.props));
  }
}

/** CapGate deps: the Control DO ledger, the BROWSER and AI bindings (no token), the WebSocket seam. */
export function capDeps(env: Env, ctx: ExecutionContext, props: GateProps): CapDeps {
  return {
    ctl: gateDeps(env, ctx, props).ctl,
    browser: env.BROWSER,
    ai: env.AI as unknown as AiBinding | undefined,
    websearch: env.AI ? (o) => (env.AI as Ai).websearch(o) : undefined,
    gateway: env.OC_AI_GATEWAY,
    now: Date.now,
    ws: {
      pair: () => {
        const p = new WebSocketPair();
        return { client: p[0], server: p[1] };
      },
      respond: (client) => new Response(null, { status: 101, webSocket: client } as ResponseInit),
    },
    waitUntil: (p) => ctx.waitUntil(p),
  };
}

/** D14: the capability gate at 15.0.0.3, the only gate uid 1000 reaches (gates/cap.ts). */
export class CapGate extends WorkerEntrypoint<Env, GateProps> {
  override fetch(req: Request): Promise<Response> {
    return handleCapGate(req, capDeps(this.env, this.ctx, this.ctx.props));
  }
}

/** docs/12: SandboxGate at 15.0.0.4, the sandbox backend's only way to the SandboxSession DO (gates/sbx.ts). */
export class SandboxGate extends WorkerEntrypoint<Env, GateProps> {
  override fetch(req: Request): Promise<Response> {
    const env = this.env;
    const p = this.ctx.props;
    return handleSandboxGate(req, {
      props: p,
      ctl: gateDeps(env, this.ctx, p).ctl,
      session: env.SANDBOX ? (env.SANDBOX.getByName(sbxName(p.inst)) as unknown as Fetcher) : null,
    });
  }
}

/** The same gate for the owner over HTTP (`/ops/gate/*`): init's model hop, `ochost model bench`, `caps`. */
export function capGateForOwner(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const rest = new URL(req.url).pathname.slice("/ops/gate".length) || "/";
  const props = { v: 1, inst: env.OC_INST, epoch: 0, gen: 0 } as unknown as GateProps;
  const fwd = new Request(`http://15.0.0.3${rest}`, req);
  return handleCapGate(fwd, capDeps(env, ctx, props));
}

/** Fakes answer 404 unless the Worker runs with OC_TEST=1 and the props carry test:true. */
const testOn = (env: Env, p: GateProps | undefined) => env.OC_TEST === "1" && p?.test === true;

function sink(env: Env, ctx: ExecutionContext, p: GateProps) {
  const ctl = gateDeps(env, ctx, p).ctl;
  return {
    gateEvent: (kind: string, msg: string, data?: unknown) => ctl.ring(kind, msg, data).catch(() => {}),
    outbound: (chatId: string | number | null, at: number, method: string) =>
      ctl.noteOutbound({ chatId, at, method }).then(
        () => undefined,
        () => undefined,
      ),
  };
}

/** L3: prod pass-through to api.telegram.org that notes reply-class calls (gates/telegram.ts). */
export class TelegramGate extends WorkerEntrypoint<Env, GateProps> {
  override fetch(req: Request): Promise<Response> {
    const s = sink(this.env, this.ctx, this.ctx.props);
    return handleTelegramGate(req, { outbound: s.outbound }, (p) => this.ctx.waitUntil(p));
  }
}

export class TelegramFake extends WorkerEntrypoint<Env, GateProps> {
  override fetch(req: Request): Promise<Response> {
    if (!testOn(this.env, this.ctx.props)) return Promise.resolve(new Response("not found", { status: 404 }));
    return handleTelegram(req, sink(this.env, this.ctx, this.ctx.props), tg);
  }
}

export class LlmMock extends WorkerEntrypoint<Env, GateProps> {
  override fetch(req: Request): Promise<Response> {
    if (!testOn(this.env, this.ctx.props)) return Promise.resolve(new Response("not found", { status: 404 }));
    const e = this.env as Env & { OC_LLM_REPLY?: string; OC_LLM_SLOW_MS?: string };
    const reply = e.OC_LLM_REPLY || "oc mock reply";
    const slow = Math.min(Number(e.OC_LLM_SLOW_MS ?? 0) || 0, 120_000);
    return handleLlm(req, sink(this.env, this.ctx, this.ctx.props), reply, Date.now, slow);
  }
}
