// M4 S5 (live): after the Control DO restarted (ctx.abort), the Runtime DO's cached stub kept failing every
// call (start ops ended `ctl-unavailable` for 13 min) until the Runtime DO itself restarted. A broken stub is not
// reused: any call that throws drops it, and the next call gets a new stub from the namespace.

/** Proxy over a DO stub that is re-created after a call throws. Every property is treated as an RPC method. */
export function freshStub<T extends object>(make: () => T): T {
  let cur: T = make();
  return new Proxy({} as T, {
    get(_t, prop) {
      if (prop === "then") return undefined; // not a thenable
      return async (...args: unknown[]) => {
        const s = cur;
        try {
          return await (s as Record<PropertyKey, (...a: unknown[]) => unknown>)[prop]?.(...args);
        } catch (e) {
          if (cur === s) cur = make();
          throw e;
        }
      };
    },
  });
}
