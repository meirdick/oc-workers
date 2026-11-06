// Boot warm-up: one tiny model call right after /startupz, so the first user turn is not the first call
// through the provider path (docs/13-cold-reply.md). Runs as a uid-1000 CLI child in the gateway cgroup.
// Modes (OCRT_WARMUP_MODE): infer = `infer model run --gateway` (raw completion, no tools, no bootstrap
// prompt, a few tokens); agent = one `agent` turn in a throw-away session (loads the whole turn path,
// pays the full system prompt). OCRT_WARMUP=1 turns it on (off by default). The call never gates anything: any failure
// is one log line.

export const WARMUP = Object.freeze({ timeoutMs: 60_000, prompt: "Reply with exactly: ok" });
export const MODES = Object.freeze(["infer", "agent", "off"]);

/**
 * Mode from env. Default off: Docker measurements (docs/13-cold-reply.md) show no first-turn gain, because the
 * webhook replay lands 1 s after /startupz and the warm-up fights it for 2 vCPUs. OCRT_WARMUP=1 → agent;
 * OCRT_WARMUP_MODE=infer|agent|off wins; unknown → off.
 */
export function warmupMode(env) {
  const m = env.OCRT_WARMUP_MODE;
  if (MODES.includes(m)) return m;
  return env.OCRT_WARMUP === "1" ? "agent" : "off";
}

/** openclaw CLI args (after the node entry) for a mode. */
export function warmupArgs(mode, { timeoutMs = WARMUP.timeoutMs, prompt = WARMUP.prompt } = {}) {
  // `infer model run` has no --timeout (2026.10.9); the runCli kill timer bounds it.
  const sec = String(Math.max(5, Math.floor(timeoutMs / 1000) - 5));
  if (mode === "agent")
    return [
      "/app/openclaw.mjs",
      "agent",
      "--agent",
      "main",
      "--session-id",
      "ochost-warmup",
      "--message",
      prompt,
      "--json",
      "--timeout",
      sec,
    ];
  return ["/app/openclaw.mjs", "infer", "model", "run", "--gateway", "--prompt", prompt, "--json"];
}

/**
 * deps: {mode, runCli(args, {timeoutMs, role}) -> {code, out, ms}, canRun() -> bool, log(ev, fields)}.
 * run() once per gateway start; a second call while one is in flight returns the same promise.
 */
export function createWarmup(deps) {
  let inflight = null;
  async function once() {
    const mode = deps.mode;
    if (mode === "off" || !MODES.includes(mode)) return { ran: false, why: "off" };
    if (!deps.canRun()) return { ran: false, why: "blocked" };
    const r = await deps.runCli(warmupArgs(mode), { timeoutMs: WARMUP.timeoutMs, role: "cli" });
    const ok = r.code === 0;
    deps.log("warmup", {
      ok,
      mode,
      ms: r.ms,
      code: r.code,
      ...(ok ? {} : { tail: String(r.out).slice(-200) }),
    });
    return { ran: true, ok, ms: r.ms };
  }
  return {
    run() {
      inflight ??= once().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
