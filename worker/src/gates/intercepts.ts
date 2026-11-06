// Intercept registration (spec §8.4, plan §5.2 step 4; m0 T6b: before-start registration holds and survives
// DO restarts). The Runtime DO calls registerIntercepts() before start() and again right after it. All
// targets are registered before start(); a failed required target means: do not call start().
import type { GateProps } from "./types";

export const CONTROL_ADDR = "15.0.0.1:80";
export const REPLICA_ADDR = "15.0.0.2:80";
export const CAP_ADDR = "15.0.0.3:80";
export const SBX_ADDR = "15.0.0.4:80";
export const TELEGRAM_HOST = "api.telegram.org";
export const LLM_HOST = "api.anthropic.com";

/** Container subset (core/container-port.ts ContainerPort; HTTPS intercepts are needed only for the fakes). */
export interface InterceptPort {
  interceptOutboundHttp(addr: string, target: Fetcher): Promise<void>;
  interceptOutboundHttps?(addr: string, target: Fetcher): Promise<void>;
}

export type EntrypointFactory = (o: { props: GateProps }) => Fetcher;
export interface GateFactories {
  ControlGate: EntrypointFactory;
  ReplicaGate: EntrypointFactory;
  CapGate: EntrypointFactory;
  /** docs/12. Optional: a Worker without it (older ctx.exports) still starts. */
  SandboxGate?: EntrypointFactory;
  TelegramFake?: EntrypointFactory;
  LlmMock?: EntrypointFactory;
}

/** Factories from `ctx.exports` (DO side). Throws if a gate class is not exported by the Worker. */
export function gateFactories(exportsObj: unknown, test: boolean): GateFactories {
  const e = (exportsObj ?? {}) as Record<string, EntrypointFactory | undefined>;
  const need = ["ControlGate", "ReplicaGate", "CapGate", ...(test ? ["TelegramFake", "LlmMock"] : [])];
  for (const n of need) if (typeof e[n] !== "function") throw new Error(`${n} entrypoint is not exported`);
  return {
    ControlGate: e.ControlGate as EntrypointFactory,
    ReplicaGate: e.ReplicaGate as EntrypointFactory,
    CapGate: e.CapGate as EntrypointFactory,
    ...(typeof e.SandboxGate === "function" ? { SandboxGate: e.SandboxGate } : {}),
    ...(test ? { TelegramFake: e.TelegramFake, LlmMock: e.LlmMock } : {}),
  };
}

/** Entrypoint props (spec §8.4). `test` is set only when the Worker runs with OC_TEST=1. */
export function gateProps(a: Omit<GateProps, "v" | "test">, env: { OC_TEST?: string }): GateProps {
  return {
    v: 1,
    inst: a.inst,
    epoch: a.epoch,
    gen: a.gen,
    mode: a.mode,
    bootSecret: a.bootSecret,
    restoreGens: [...a.restoreGens],
    ...(env.OC_TEST === "1" ? { test: true } : {}),
  };
}

export interface InterceptTarget {
  addr: string;
  tls: boolean;
  cls: keyof GateFactories;
  required: boolean;
}

/** Targets in registration order. The fakes only in test mode (OC_TEST=1). */
export function interceptTargets(test: boolean): InterceptTarget[] {
  const t: InterceptTarget[] = [
    { addr: CONTROL_ADDR, tls: false, cls: "ControlGate", required: true },
    { addr: REPLICA_ADDR, tls: false, cls: "ReplicaGate", required: true },
    { addr: CAP_ADDR, tls: false, cls: "CapGate", required: false },
    { addr: SBX_ADDR, tls: false, cls: "SandboxGate", required: false },
  ];
  if (test)
    t.push(
      { addr: TELEGRAM_HOST, tls: true, cls: "TelegramFake", required: true },
      { addr: LLM_HOST, tls: true, cls: "LlmMock", required: true },
    );
  return t;
}

export interface InterceptResult {
  ok: boolean;
  results: Record<string, { ok: boolean; ms: number; error?: string }>;
  failed: string[];
}

/**
 * Register every target, in order, before start(). Each target is tried even after a failure, so the
 * result names all failures. ok=false → the caller must not call start() (fail-safe of plan §5.2 step 4).
 */
export async function registerIntercepts(
  c: InterceptPort,
  f: GateFactories,
  props: GateProps,
  now: () => number = Date.now,
): Promise<InterceptResult> {
  const results: InterceptResult["results"] = {};
  const failed: string[] = [];
  for (const t of interceptTargets(props.test === true)) {
    const t0 = now();
    try {
      const make = f[t.cls];
      if (!make) throw new Error(`${t.cls} factory missing`);
      const target = make({ props });
      if (t.tls) {
        if (!c.interceptOutboundHttps) throw new Error("interceptOutboundHttps not available on this port");
        await c.interceptOutboundHttps(t.addr, target);
      } else await c.interceptOutboundHttp(t.addr, target);
      results[t.addr] = { ok: true, ms: now() - t0 };
    } catch (e) {
      results[t.addr] = { ok: false, ms: now() - t0, error: e instanceof Error ? e.message : String(e) };
      if (t.required) failed.push(t.addr);
    }
  }
  return { ok: failed.length === 0, results, failed };
}
