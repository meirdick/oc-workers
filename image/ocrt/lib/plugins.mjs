// Plugin check at boot (plan §6.2 step 4, §4.9 "Plugin skipped at restore"; scope §1.1 row "Plugins").
// Every boot path: compare the plan's manifest with `openclaw plugins list --json` (uid 1000).
// Missing → reinstall (`plugins install <spec> --pin` + recorded flags). A failed install →
// per-boot overlay `plugins.entries.<id>.enabled=false` (the one overlay v1 allows), no `bad`
// version, alert `plugin-missing`, `degraded`, retry every 15 min in the background. On success
// the overlay entry goes and the gateway restarts at the next idle point.
// Installed plugins that are not in the manifest → alert `plugins-changed` (no hold in v1).

export const RETRY_MS = 15 * 60_000;

/** Parse `plugins list --json` output (banner lines may come first). Returns [{id, origin, enabled}]. */
export function parseList(out) {
  const s = String(out || "");
  const i = s.indexOf("{");
  if (i < 0) return null;
  try {
    const j = JSON.parse(s.slice(i));
    return (j.plugins || []).map((p) => ({
      id: p.id,
      origin: p.origin,
      enabled: p.enabled,
      version: p.version,
    }));
  } catch {
    return null;
  }
}

/**
 * Compare. manifest = {plugins: [{id, spec, flags?}]}. installed = parseList(). Returns
 * {missing: [entry], extra: [id]}. Bundled plugins are never "extra".
 */
export function diff(manifest, installed) {
  const have = new Set(installed.map((p) => p.id));
  const want = new Set((manifest?.plugins || []).map((p) => p.id));
  return {
    missing: (manifest?.plugins || []).filter((p) => !have.has(p.id)),
    extra: installed.filter((p) => p.origin !== "bundled" && !want.has(p.id)).map((p) => p.id),
  };
}

/** argv for one install (plan §6.2 step 4). */
export function installArgs(entry) {
  return ["plugins", "install", entry.spec, "--pin", ...(entry.flags || [])];
}

/**
 * Boot check. deps: {runCli(args, o) -> {code, out}, alert(cls, sev, detail), log}.
 * Returns {missing: [id], extra: [id], installed: [id], listFailed?}.
 */
export async function checkAtBoot(manifest, deps) {
  const res = { missing: [], extra: [], installed: [] };
  if (!manifest?.plugins?.length) return res;
  const l = await deps.runCli(["plugins", "list", "--json"], { timeoutMs: 120_000, role: "cli" });
  const list = l.code === 0 ? parseList(l.out) : null;
  if (!list) {
    // Cannot tell: treat every manifest entry as present (no overlay on a list failure), alert.
    deps.alert?.("plugin-missing", "warn", "plugins list failed");
    return { ...res, listFailed: true };
  }
  const d = diff(manifest, list);
  res.extra = d.extra;
  if (d.extra.length) deps.alert?.("plugins-changed", "info", d.extra.join(","));
  for (const e of d.missing) {
    const r = await deps.runCli(installArgs(e), { timeoutMs: 300_000, role: "cli" });
    if (r.code === 0) res.installed.push(e.id);
    else res.missing.push(e.id);
    deps.log?.("plugin-install", { id: e.id, code: r.code });
  }
  if (res.missing.length) deps.alert?.("plugin-missing", "warn", res.missing.join(","));
  return res;
}

/**
 * Background retry for missing plugins. deps: {runCli, onInstalled(id), log, now}. Call tick() every
 * minute; it tries at most once per 15 min. Returns the ids still missing.
 */
export function createPluginRetry(manifest, missing, deps) {
  const left = new Map((manifest?.plugins || []).filter((p) => missing.includes(p.id)).map((p) => [p.id, p]));
  let last = 0;
  const now = deps.now || Date.now;
  return {
    missing: () => [...left.keys()],
    async tick() {
      if (!left.size || now() - last < RETRY_MS) return [...left.keys()];
      last = now();
      for (const [id, e] of left) {
        const r = await deps.runCli(installArgs(e), { timeoutMs: 300_000, role: "cli" });
        deps.log?.("plugin-retry", { id, code: r.code });
        if (r.code === 0) {
          left.delete(id);
          await deps.onInstalled?.(id);
        }
      }
      return [...left.keys()];
    },
  };
}

/**
 * Bundled extensions an older install may hold an npm record for (firecrawl was an npm install before the image baked
 * it; image/Dockerfile puts it in /app/dist/extensions). cf-web-search is new, so no older record.
 */
export const RECORDED_BUNDLED_DIRS = ["/app/dist/extensions/firecrawl"];

/** argv that records a bundled plugin as a path install (a link, so nothing is copied or fetched). */
export function pathInstallArgs(dir) {
  return ["plugins", "install", "--link", "--force", "--accept-capabilities", "--no-enable", dir];
}

/**
 * Bundled plugin dirs whose install record is not a path install of that dir. An install from before the image baked
 * the plugin (npm, firecrawl) left an npm record in the state DB; with its npm dir gone, Doctor and `config validate`
 * say "settings cannot be checked until its data/settings upgrade finishes" and Doctor tries npm again.
 * dirs: [{dir, id}], records: {<id>: {source, installPath}}. A plugin with no record is fine.
 */
export function staleInstalls(dirs, records) {
  return dirs.filter(({ dir, id }) => {
    const r = records?.[id];
    return !!r && !(r.source === "path" && r.installPath === dir);
  });
}
