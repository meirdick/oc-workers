// Proactive-check schedule override in duty-cycle mode (addendum §2.3 "Proactive check", U2 default yes).
// sleep.proactive: "2h@08-22" (default) → cron "0 8-22/2 * * *" in the install time zone;
// "off" → disable the job; "openclaw" → leave the upstream cadence.
// Find the job per agent by the proactive receipt (config_machine_state key
// `automation-default:<store>:<agent>`, value {jobId}), never by a fixed id. Fallback: a job whose
// payload.message equals DEFAULT_PROACTIVE_PROMPT. Zero or > 1 match per agent: change nothing;
// alert `proactive-unmatched` only when a "Proactive check (" job exists (2026.10.9 has no
// default Proactive job, so zero jobs is the normal case there; deviation from add §2.3, which
// alerts on zero too).

export const DEFAULT_PROACTIVE_PROMPT =
  "Review your automation scratch checklist and relevant session context. Do not infer or repeat old tasks from prior conversations. Take useful action only when needed. Use NO_REPLY when there is nothing to tell the user.";

/** "Nh@HH-HH" → cron expression; "off" | "openclaw" pass through. Throws on a bad spec. */
export function cronFor(spec = "2h@08-22") {
  if (spec === "off" || spec === "openclaw") return spec;
  const m = /^(\d{1,2})h@(\d{2})-(\d{2})$/.exec(spec);
  if (!m) throw new Error(`proactive: bad spec ${spec}`);
  const [every, from, to] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (every < 1 || every > 24 || from > 23 || to > 23 || from > to)
    throw new Error(`proactive: bad spec ${spec}`);
  return `0 ${from}-${to}/${every} * * *`;
}

/**
 * Pick one job per agent. receipts = [{state_key, value_json}], jobs = [{job_id, name, agent_id,
 * enabled, job_json}]. Returns {agents: {<agent>: {jobId, by: receipt|prompt, job}},
 * unmatched: [{agent, why}]}.
 */
export function pickJobs(receipts, jobs) {
  const byId = new Map(jobs.map((j) => [j.job_id, j]));
  const parsed = jobs.map((j) => {
    let o = {};
    try {
      o = JSON.parse(j.job_json);
    } catch {}
    return { ...j, job: o };
  });
  const agents = {};
  const unmatched = [];
  for (const r of receipts) {
    const agent = String(r.state_key).split(":").at(-1);
    let v = null;
    try {
      v = JSON.parse(r.value_json);
    } catch {}
    const j = v?.jobId && byId.get(v.jobId);
    if (j)
      agents[agent] = { jobId: v.jobId, by: "receipt", job: parsed.find((x) => x.job_id === v.jobId).job };
    else unmatched.push({ agent, why: "receipt job missing" });
  }
  const byPrompt = {};
  for (const j of parsed) {
    if (j.job?.payload?.message !== DEFAULT_PROACTIVE_PROMPT) continue;
    const a = j.agent_id || j.job.agentId || "main";
    if (!byPrompt[a]) byPrompt[a] = [];
    byPrompt[a].push(j);
  }
  for (const [a, list] of Object.entries(byPrompt)) {
    if (agents[a]) continue;
    const u = unmatched.findIndex((x) => x.agent === a);
    if (u >= 0) unmatched.splice(u, 1);
    if (list.length === 1) agents[a] = { jobId: list[0].job_id, by: "prompt", job: list[0].job };
    else unmatched.push({ agent: a, why: `${list.length} prompt matches` });
  }
  const named = parsed.some((j) => /^Proactive check \(/.test(j.name || ""));
  for (const j of parsed)
    if (/^Proactive check \(/.test(j.name || "")) {
      const a = j.agent_id || j.job.agentId || "main";
      if (!agents[a] && !unmatched.some((x) => x.agent === a))
        unmatched.push({ agent: a, why: "named job, no receipt or prompt match" });
    }
  return { agents, unmatched, named };
}

/** CLI args to apply the spec to one job, or null if it already has it. */
export function editArgs(jobId, job, spec, tz = "UTC") {
  const c = cronFor(spec);
  if (c === "openclaw") return null;
  if (c === "off") return job?.enabled === false ? null : ["cron", "edit", jobId, "--disable"];
  const s = job?.schedule || {};
  if (s.kind === "cron" && s.expr === c && (s.tz || "UTC") === tz && job?.enabled !== false) return null;
  return ["cron", "edit", jobId, "--cron", c, "--tz", tz, ...(job?.enabled === false ? ["--enable"] : [])];
}

/**
 * After /startupz (duty-cycle only). deps: {read() -> {receipts, jobs} (ocio, read-only),
 * runCli(args, o), alert, log}. Returns {edited: [id], unchanged: [id], unmatched}.
 */
export async function applyProactive(spec, tz, deps) {
  const res = { edited: [], unchanged: [], unmatched: [] };
  if (cronFor(spec) === "openclaw") return res;
  const data = await deps.read();
  if (!data) return { ...res, error: "read-failed" };
  const p = pickJobs(data.receipts || [], data.jobs || []);
  res.unmatched = p.unmatched;
  if (p.unmatched.length)
    deps.alert?.("proactive-unmatched", "warn", p.unmatched.map((u) => `${u.agent}:${u.why}`).join(","));
  for (const [agent, a] of Object.entries(p.agents)) {
    const args = editArgs(a.jobId, a.job, spec, tz);
    if (!args) {
      res.unchanged.push(a.jobId);
      continue;
    }
    const r = await deps.runCli(args, { timeoutMs: 30_000, role: "cli" });
    deps.log?.("proactive-edit", { agent, jobId: a.jobId, by: a.by, code: r.code, args });
    if (r.code === 0) res.edited.push(a.jobId);
    else res.unmatched.push({ agent, why: `edit exit ${r.code}` });
  }
  return res;
}
