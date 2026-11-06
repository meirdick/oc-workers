// Auth DO namespace for vitest: the real Auth class on node:sqlite (FakeStorage), RPC-like cloning.
import { Auth, authName } from "../../src/ingress/auth-do";
import { FakeStorage } from "../harness/storage";

export interface FakeAuthNs {
  ns: DurableObjectNamespace;
  calls: { name: string; m: string }[];
  storage: FakeStorage;
}

export function fakeAuthNs(env: () => Record<string, unknown>): FakeAuthNs {
  const storage = new FakeStorage();
  const calls: { name: string; m: string }[] = [];
  let inst: Auth | null = null;
  const stub = (name: string) =>
    new Proxy(
      {},
      {
        get(_t, m) {
          if (m === "then") return undefined;
          return async (...a: unknown[]) => {
            calls.push({ name, m: String(m) });
            inst ??= new Auth({ storage } as unknown as DurableObjectState, env() as never);
            const f = (inst as unknown as Record<string, (...x: unknown[]) => unknown>)[String(m)];
            if (typeof f !== "function") throw new Error(`Auth.${String(m)} is not an RPC method`);
            const r = await f.apply(
              inst,
              a.map((x) => structuredClone(x)),
            );
            return r === undefined ? r : structuredClone(r);
          };
        },
      },
    );
  return {
    ns: {
      getByName: stub,
      idFromName: (n: string) => ({ name: n }),
      get: (id: { name: string }) => stub(id.name),
    } as never,
    calls,
    storage,
  };
}

/** A logged-in owner cookie header value (`__Host-ochost=...`), for tests that only need a session. */
export async function ownerCookie(env: Record<string, unknown>): Promise<string> {
  const ns = env.AUTH as DurableObjectNamespace;
  const a = ns.getByName(authName(String(env.OC_INST))) as unknown as {
    login(x: { token: string; ip: string; ua: string }): Promise<{ ok: boolean; cookie?: string }>;
  };
  const r = await a.login({ token: String(env.CONTROL_TOKEN), ip: "test", ua: "vitest" });
  if (!r.ok || !r.cookie) throw new Error("ownerCookie: login failed");
  return `__Host-ochost=${r.cookie}`;
}
