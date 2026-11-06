// Config watcher (plan §4.9 "Watch and merge" as cut by scope §1.1). Reads go through ocio
// (root never opens openclaw.json). The watcher reports each settled change as a candidate
// version (PUT /v1/config/proposal), only when proposals are allowed for this boot.
// It also keeps lastConfigWriteAt (ocsup's own writes) and lastConfigReloadAt (gateway log),
// which feed sleep phase 1 blocker (b) (amend §3 row "T7e row 19").
import { proposalFrom, RELOAD_LINE } from "./config.mjs";

/**
 * deps: {readFile() -> Promise<{text}|null> (via ocio), propose(p) -> Promise<{status}>,
 * alert(cls, sev, detail), log, now}. rendered = config.render() result; version = selected.
 */
export function createConfigWatch(deps, rendered, version) {
  const st = {
    lastConfigWriteAt: 0,
    lastConfigReloadAt: 0,
    lastSha: rendered.sha,
    proposed: [],
    suppressed: 0,
  };
  const now = deps.now || Date.now;

  /** Call after ocsup writes openclaw.json through ocio. */
  function noteWrite(sha) {
    st.lastConfigWriteAt = now();
    st.lastSha = sha;
  }

  /** Feed each gateway stdout line. */
  function onGatewayLine(line) {
    if (RELOAD_LINE.test(line)) st.lastConfigReloadAt = now();
  }

  /** Check the file once (call on fs.watch events from the ocio watcher and every 30 s). */
  async function check(source = "ui") {
    const f = await deps.readFile();
    if (!f) return { action: "none", why: "unreadable" };
    let doc;
    try {
      doc = JSON.parse(f.text);
    } catch {
      return { action: "none", why: "torn" }; // wait for the next event
    }
    const p = proposalFrom(doc, rendered, version, source);
    if (!p) return { action: "none", why: "equal" };
    if (p.sha === st.lastProposedSha) return { action: "none", why: "same-as-last" };
    if (!rendered.proposals) {
      st.suppressed++;
      deps.log?.("config-proposal-suppressed", {
        why: "overlay-or-dark",
        sha: p.sha,
        overlay: rendered.overlay.length,
      });
      return { action: "suppressed", sha: p.sha };
    }
    const { sensitive, ...body } = p;
    const r = await deps.propose(body);
    st.lastProposedSha = p.sha;
    st.proposed.push({ sha: p.sha, at: now(), status: r?.status });
    if (sensitive.length) deps.alert?.("config-sensitive", "warn", sensitive.join(","));
    deps.log?.("config-proposal", { sha: p.sha, source, status: r?.status, sensitive });
    return { action: "proposed", sha: p.sha, sensitive };
  }

  /** Sleep check blocker (b): a config apply in the last 60 s. */
  function recentApply(windowMs = 60_000) {
    const t = Math.max(st.lastConfigWriteAt, st.lastConfigReloadAt);
    return t > 0 && now() - t < windowMs;
  }

  return { state: st, noteWrite, onGatewayLine, check, recentApply };
}
