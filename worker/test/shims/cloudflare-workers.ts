// Node stand-in for the `cloudflare:workers` module. Vitest aliases the import to this file
// (worker/vitest.config.ts). Only what the Worker code subclasses or reads is here.

export class DurableObject<Env = unknown> {
  constructor(
    public ctx: DurableObjectState,
    public env: Env,
  ) {}
}

export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  constructor(
    public ctx: ExecutionContext & { props: Props },
    public env: Env,
  ) {}
}

export class RpcTarget {}

/** Module-level env. The world sets it before it constructs a class. */
export const env: Record<string, unknown> = {};
