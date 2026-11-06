// ochost config get|set|pull, secrets set|list, advanced … (docs/10-cli-spec.md §1.2).
// Thin /ops clients. config works on the OpenClaw config versions in the Control DO (GET/POST /ops/config);
// the working copy is openclaw.jsonc, and oc-host.jsonc `baseVersion` guards against lost updates.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  checkValue,
  expand,
  fileOf,
  flatten,
  SPECS,
  specOf,
  specOfFile,
} from "../../worker/src/core/tunables.ts";
import {
  applyChange,
  looseOps,
  manifestPath,
  patchLlm,
  recordSecret,
  registerBoth,
  setBaseVersion,
  sub,
  wantRestart,
} from "./cmd-util.ts";
import { parseJsonc, RENDER_VERSION, validateConfig, workerSettings } from "./config.ts";
import { currentConfig, proposeConfig } from "./model.ts";
import {
  CliError,
  EXIT,
  type FlagSpec,
  flagBool,
  flagStr,
  fmtTime,
  loadInstall,
  type OpsCtx,
  opsClient,
  putSecret,
  readHostConfig,
  table,
  usage,
  wrangler,
} from "./ops-lib.ts";
import { diffLine, renderIntoConfig } from "./render-config.ts";
import { readManifest, readTokenFile } from "./secrets.ts";
import { setPathJsonc } from "./sleep.ts";

// ---------------------------------------------------------------- config

export const configFlags: FlagSpec = {
  ver: { type: "string" },
  restart: { type: "boolean" },
  force: { type: "boolean" },
  unset: { type: "boolean" },
  "dry-run": { type: "boolean" },
};

export const WORKING_COPY = "openclaw.jsonc";

/** Dotted path → keys. `a.b[0].c` and `a.b.0.c` both work. */
export function pathKeys(path: string): string[] {
  const keys = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((k) => k !== "");
  if (!keys.length || keys.some((k) => k === "__proto__" || k === "constructor" || k === "prototype"))
    throw usage(`bad config path ${path}`, "use a dotted path like agents.defaults.model.primary");
  return keys;
}

export function getPath(doc: unknown, path: string): unknown {
  let cur: any = doc;
  for (const k of pathKeys(path)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Pure: a copy of `doc` with `path` set to `value` (undefined deletes the key). */
export function setPath(doc: Record<string, any>, path: string, value: unknown): Record<string, any> {
  const next = structuredClone(doc);
  const keys = pathKeys(path);
  let cur: any = next;
  keys.slice(0, -1).forEach((k, i) => {
    if (cur[k] === null || typeof cur[k] !== "object") cur[k] = /^\d+$/.test(keys[i + 1] as string) ? [] : {};
    cur = cur[k];
  });
  const last = keys[keys.length - 1] as string;
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return next;
}

/** `<json>` argument: JSON first; a bare word that is not JSON is taken as a string. */
export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    if (/^[\s{["]/.test(raw))
      throw usage(`value is not valid JSON: ${raw.slice(0, 40)}`, "quote the JSON value");
    return raw;
  }
}

function workingCopyText(ver: number, doc: unknown): string {
  return `// OpenClaw config, version ${ver}, pulled by ochost config pull. The Control DO owns it; edit with\n// ochost config set <path> <json>. Managed keys (gateway auth, trusted proxy, origin) are added by the Worker.\n${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * `config get|set <key>` where <key> is an oc-host.jsonc setting (sleep.idleMinutes, archive.everyHours, ...):
 * the Worker's settings document and oc-host.jsonc change together, and the Worker applies it at its next op.
 * `config settings` shows the document, the effective values and the versions.
 */
async function settingsCommand(ctx: OpsCtx, verb: string): Promise<number> {
  const ops = opsClient(ctx);
  const path = ctx.args.positionals[1];
  const spec = path ? specOfFile(path) : undefined;
  if (verb === "settings" || (verb === "get" && spec)) {
    const r = await ops.call("GET", "/ops/settings");
    const eff = flatten(r.body?.effective ?? {});
    if (spec) {
      const v = eff[spec.path];
      if (ctx.out.json) ctx.out.result({ ok: true, ver: r.body?.ver, path, value: v ?? null });
      else ctx.out.line(String(v));
    } else if (ctx.out.json) ctx.out.result({ ok: true, ...r.body });
    else
      ctx.out.line(
        `settings version ${r.body?.ver}${r.body?.source ? ` (${r.body.source})` : ""}\n${table(
          ["KEY", "VALUE", "SET"],
          SPECS.map((x) => [
            fileOf(x),
            String(eff[x.path]),
            flatten(r.body?.doc ?? {})[x.path] === undefined ? "default" : "yes",
          ]),
        )}`,
      );
    return EXIT.ok;
  }
  const unset = flagBool(ctx.args, "unset");
  const raw = ctx.args.positionals[2];
  if (!spec || (raw === undefined && !unset))
    throw usage("config set needs a setting and a value", "ochost config set sleep.idleMinutes 10");
  const value = unset ? spec.def : parseValue(raw as string);
  const bad = checkValue(spec, value);
  if (bad) throw usage(bad, "ochost config settings lists the keys");
  const r = await ops.call(
    "PUT",
    "/ops/settings",
    { set: { [spec.path]: unset ? null : value }, source: "cli" },
    { allow: [200, 400, 409] },
  );
  if (r.status !== 200)
    throw new CliError(
      `the Worker refused ${path}: ${String(r.body?.error ?? r.status)}`,
      "oc-host.jsonc is unchanged; ochost config settings shows the live values",
    );
  const file = join(ctx.dir, "oc-host.jsonc");
  let text: string | null = null;
  try {
    text = await readFile(file, "utf8");
  } catch {}
  let wrote = false;
  if (text !== null) {
    const next = setPathJsonc(text, path as string, value as string | number);
    if (next !== null) {
      await writeFile(file, next);
      wrote = true;
    }
  }
  if (ctx.out.json)
    ctx.out.result({ ok: true, ver: r.body.ver, changed: r.body.changed, path, value, file: wrote });
  else
    ctx.out.line(
      `settings version ${r.body.ver}${r.body.changed ? "" : " (no change)"}: ${path} = ${JSON.stringify(value)}${wrote ? "; oc-host.jsonc updated" : ""}\napplies at the next op; no deploy needed`,
    );
  return EXIT.ok;
}

/**
 * `ochost settings [show|push]`: show lists the live values (same as `config settings`). push sends the tuning
 * keys of oc-host.jsonc as the whole settings document (keys the file omits go back to their default), so the
 * file and the Worker agree. Applies at the next op; no deploy.
 */
export async function settings(ctx: OpsCtx): Promise<number> {
  const verb = sub(ctx, ["show", "push"], "show");
  if (verb === "show")
    return settingsCommand({ ...ctx, args: { ...ctx.args, positionals: ["settings"] } }, "settings");
  const file = join(ctx.dir, "oc-host.jsonc");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new CliError(`no oc-host.jsonc in ${ctx.dir}`, "run ochost config pull, or ochost init");
  }
  const cfg = validateConfig(parseJsonc(text));
  // Only the tuning keys: env-owned keys (publicOrigin, sandbox, telegram.wakeProgress) stay with deploy.
  const doc = expand(
    Object.fromEntries(Object.entries(flatten(workerSettings(cfg, ""))).filter(([p]) => specOf(p))),
  );
  const r = await opsClient(ctx).call(
    "PUT",
    "/ops/settings",
    { doc: JSON.parse(JSON.stringify(doc)), source: "push" },
    { allow: [200, 400, 409] },
  );
  if (r.status !== 200)
    throw new CliError(
      `the Worker refused the settings: ${String(r.body?.error ?? r.status)}`,
      "fix oc-host.jsonc, then ochost settings push",
    );
  if (ctx.out.json) ctx.out.result({ ok: true, ver: r.body.ver, changed: r.body.changed });
  else
    ctx.out.line(
      `settings version ${r.body.ver}${r.body.changed ? "" : " (no change)"}: pushed oc-host.jsonc\napplies at the next op; no deploy needed`,
    );
  return EXIT.ok;
}

export async function config(ctx: OpsCtx): Promise<number> {
  const s = sub(ctx, ["get", "set", "pull", "list", "settings", "render"], "get");
  if (s === "settings" || ((s === "get" || s === "set") && specOfFile(ctx.args.positionals[1] ?? "")))
    return settingsCommand(ctx, s);
  const ops = opsClient(ctx);
  const lo = looseOps(ops);
  if (s === "render") {
    const dryRun = flagBool(ctx.args, "dry-run");
    await lo.post("/ops/render-check", { renderVersion: RENDER_VERSION }).catch(() => undefined);
    let r: Awaited<ReturnType<typeof renderIntoConfig>>;
    try {
      r = await renderIntoConfig(lo, { dryRun });
    } catch (e) {
      throw new CliError(String((e as Error).message), "ochost config pull, then ochost config render");
    }
    if (!r.from) throw new CliError("the install has no config version", "run ochost init");
    const applied = r.action === "merged" ? await applyChange(ctx, ops, wantRestart(ctx)) : "none";
    if (r.action === "merged") await setBaseVersion(ctx, r.ver);
    if (ctx.out.json) ctx.out.result({ ok: true, ...r, applied });
    else
      ctx.out.line(
        r.action === "dry"
          ? `config version ${r.from}, render version ${r.docRenderVersion}: would change ${diffLine(r.diff)}`
          : r.action === "none"
            ? `config version ${r.ver} already matches the render`
            : `config version ${r.ver} (was ${r.from}): ${diffLine(r.diff)}\napplies at the next start; ochost restart applies it now`,
      );
    return EXIT.ok;
  }
  if (s === "list") {
    const r = await ops.call("GET", "/ops/config");
    const vs = (r.body?.versions ?? []) as {
      ver: number;
      status: string;
      source: string;
      created_at: number;
    }[];
    if (ctx.out.json) ctx.out.result({ ok: true, versions: vs });
    else
      ctx.out.line(
        vs.length
          ? table(
              ["VER", "STATUS", "SOURCE", "CREATED"],
              vs.map((v) => [String(v.ver), v.status, v.source, fmtTime(v.created_at)]),
            )
          : "no config version yet. Run ochost init",
      );
    return EXIT.ok;
  }
  if (s === "get") {
    const want = flagStr(ctx.args, "ver");
    let ver: number;
    let doc: Record<string, any>;
    if (want) {
      const r = await ops.call("GET", `/ops/config/${Number(want)}`, undefined, { allow: [200, 404] });
      if (r.status === 404) throw new CliError(`no config version ${want}`, "ochost config list");
      ver = Number(want);
      doc = r.body?.doc ?? {};
    } else ({ ver, doc } = await currentConfig(lo));
    const path = ctx.args.positionals[1];
    const value = path ? getPath(doc, path) : doc;
    if (path && value === undefined && !ctx.out.json)
      throw new CliError(
        `${path} is not set in config version ${ver}`,
        "ochost config get shows the whole doc",
      );
    if (ctx.out.json) ctx.out.result({ ok: true, ver, path: path ?? null, value: value ?? null });
    else ctx.out.line(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return EXIT.ok;
  }
  if (s === "pull") {
    const { ver, doc } = await currentConfig(lo);
    if (!ver) throw new CliError("the install has no config version", "run ochost init");
    const file = join(ctx.dir, WORKING_COPY);
    await writeFile(file, workingCopyText(ver, doc));
    await setBaseVersion(ctx, ver);
    if (ctx.out.json) ctx.out.result({ ok: true, ver, file });
    else ctx.out.line(`wrote ${WORKING_COPY} (version ${ver}); oc-host.jsonc baseVersion ${ver}`);
    return EXIT.ok;
  }
  // set
  const path = ctx.args.positionals[1];
  const raw = ctx.args.positionals[2];
  const unset = flagBool(ctx.args, "unset");
  if (!path || (raw === undefined && !unset))
    throw usage(
      "config set needs a path and a value",
      "ochost config set agents.defaults.model.primary '\"cfgw/@cf/…\"'",
    );
  const value = unset ? undefined : parseValue(raw as string);
  const { ver, doc } = await currentConfig(lo);
  const base = readHostConfig(ctx.dir)?.baseVersion;
  if (typeof base === "number" && base !== ver && !flagBool(ctx.args, "force"))
    throw new CliError(
      `config changed elsewhere (base ${base}, current ${ver})`,
      "run ochost config pull, then set again",
    );
  const next = setPath(doc, path, value);
  const r = await proposeConfig(lo, next, ver);
  await setBaseVersion(ctx, r.ver);
  if (!r.same) {
    try {
      await readFile(join(ctx.dir, WORKING_COPY));
      await writeFile(join(ctx.dir, WORKING_COPY), workingCopyText(r.ver, next));
    } catch {}
  }
  // Keep the local mirror (oc-host.jsonc llm.primary) in step with the doc.
  const prim = getPath(next, "agents.defaults.model.primary");
  if (typeof prim === "string" && prim.startsWith("cfgw/")) await patchLlm(ctx, { primary: prim.slice(5) });
  const applied = r.same ? "none" : await applyChange(ctx, ops, wantRestart(ctx));
  if (ctx.out.json) ctx.out.result({ ok: true, ver: r.ver, same: r.same, path, applied });
  else ctx.out.line(`config version ${r.ver}${r.same ? " (no change)" : ""}: ${path} set`);
  return EXIT.ok;
}

// ---------------------------------------------------------------- secrets

export const secretsFlags: FlagSpec = {
  "from-file": { type: "string" },
  "no-restart": { type: "boolean" },
};

export const SECRET_PREFIX = "OC_SECRET_";
/** Names with their own command. NAME is checked with and without the OC_ prefix. */
const OWNED: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "ochost channels add telegram",
  TELEGRAM_WEBHOOK_SECRET: "ochost auth rotate --webhook",
  SLACK_BOT_TOKEN: "ochost channels add slack",
  SLACK_SIGNING_SECRET: "ochost channels add slack",
  DISCORD_BOT_TOKEN: "ochost channels add discord",
  DISCORD_PUBLIC_KEY: "ochost channels add discord",
  TWILIO_AUTH_TOKEN: "ochost channels add twilio",
  CF_AI_TOKEN: "nothing; model calls use the Worker's AI binding, no token",
  GATEWAY_TOKEN: "nothing; init manages it",
};

/** NAME → Worker secret OC_SECRET_<NAME>; the gateway sees it as env NAME (worker/src/rt/runtime.ts). */
export function secretName(name: string): string {
  const n = name.startsWith(SECRET_PREFIX) ? name.slice(SECRET_PREFIX.length) : name;
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(n))
    throw usage(`bad secret name ${name}`, "use A-Z, 0-9 and _, starting with a letter");
  const bare = n.replace(/^OC_/, "");
  const owner = OWNED[bare];
  if (owner)
    throw new CliError(
      `${n} is a ${/^(TELEGRAM|SLACK|DISCORD|TWILIO)/.test(bare) ? "channel" : "managed"} secret`,
      `use ${owner}`,
    );
  return `${SECRET_PREFIX}${n}`;
}

export async function secrets(ctx: OpsCtx): Promise<number> {
  const s = sub(ctx, ["set", "list"], "list");
  const install = loadInstall(ctx);
  if (s === "list") {
    const m = await readManifest(manifestPath(ctx.dir));
    const w = await wrangler(ctx, install, ["secret", "list", "--name", install.name, "--format", "json"]);
    let onWorker: string[] | null = null;
    if (w.code === 0) {
      try {
        onWorker = (JSON.parse(w.stdout) as { name: string }[]).map((x) => x.name);
      } catch {}
    }
    if (onWorker === null) ctx.out.warn("could not read wrangler secret list — fix: npx wrangler login");
    const names = [...new Set([...Object.keys(m), ...(onWorker ?? [])])].sort();
    const rows = names.map((n) => ({
      name: n,
      setAt: m[n]?.setAt ?? null,
      local: Boolean(m[n]),
      worker: onWorker === null ? null : onWorker.includes(n),
    }));
    if (ctx.out.json) ctx.out.result({ ok: true, secrets: rows });
    else
      ctx.out.line(
        table(
          ["NAME", "SET", "MANIFEST", "WORKER"],
          rows.map((r) => [
            r.name,
            r.setAt ? r.setAt.slice(0, 19).replace("T", " ") : "-",
            r.local ? "yes" : "-",
            r.worker === null ? "?" : r.worker ? "yes" : "MISSING",
          ]),
        ),
      );
    return EXIT.ok;
  }
  const raw = ctx.args.positionals[1];
  if (!raw) throw usage("secrets set needs a NAME", "ochost secrets set MY_API_KEY");
  const name = secretName(raw);
  const file = flagStr(ctx.args, "from-file");
  let value = "";
  if (file) {
    try {
      value = await readTokenFile(resolve(file), (l) => ctx.out.warn(l));
    } catch (e) {
      throw new CliError(`cannot read ${file} (${(e as Error).message})`, "check the path, then rerun");
    }
  } else if (ctx.nonInteractive)
    throw new CliError(`no value for ${raw}`, "rerun with --from-file <f>", EXIT.manual);
  else value = (await ctx.prompts.askHidden(`Value for ${raw} (input is hidden), then Enter: `)).trim();
  if (!value) throw new CliError(`empty value for ${raw}`, "rerun and paste the value");
  registerBoth(value);
  await putSecret(ctx, install, name, value);
  await recordSecret(ctx, name, value);
  ctx.out.step(`secret ${name} set on Worker ${install.name}`);
  const applied = await applyChange(ctx, opsClient(ctx, install), !flagBool(ctx.args, "no-restart"));
  if (ctx.out.json) ctx.out.result({ ok: true, name, env: name.slice(SECRET_PREFIX.length), applied });
  else ctx.out.line(`${name} set; the gateway sees it as \${${name.slice(SECRET_PREFIX.length)}}`);
  return EXIT.ok;
}

// ---------------------------------------------------------------- advanced (hidden from first-week help)

export const advancedFlags: FlagSpec = {
  plan: { type: "boolean" },
  apply: { type: "boolean" },
  path: { type: "string" },
  lines: { type: "string" },
};

export const ADVANCED_HELP = [
  "ochost advanced creds [history --path <p>]   credential store manifest or one file's history",
  "ochost advanced prune --plan | --apply        image GC plan, or run it",
  "ochost advanced inbox                         webhook inbox counts and rows",
  "ochost advanced events [--lines N]            raw ring events (JSON)",
].join("\n");

export async function advanced(ctx: OpsCtx): Promise<number> {
  const s = sub(ctx, ["creds", "prune", "inbox", "events"]);
  const ops = opsClient(ctx);
  let body: unknown;
  if (s === "creds") {
    const h = ctx.args.positionals[1] === "history";
    const p = flagStr(ctx.args, "path");
    if (h && !p) throw usage("creds history needs --path", "ochost advanced creds history --path <file>");
    body = (
      await ops.call("GET", h ? `/ops/creds/history?path=${encodeURIComponent(p as string)}` : "/ops/creds")
    ).body;
  } else if (s === "prune") {
    const apply = flagBool(ctx.args, "apply");
    if (!apply && !flagBool(ctx.args, "plan"))
      throw usage("prune needs --plan or --apply", "ochost advanced prune --plan");
    body = (apply ? await ops.call("POST", "/ops/gc") : await ops.call("GET", "/ops/gc")).body;
  } else if (s === "inbox") body = (await ops.call("GET", "/ops/inbox")).body;
  else {
    const n = Math.min(500, Math.max(1, Number(flagStr(ctx.args, "lines") ?? 200) || 200));
    body = (await ops.call("GET", `/ops/events?limit=${n}`)).body;
  }
  if (ctx.out.json) ctx.out.result({ ok: true, [s]: body });
  else ctx.out.line(JSON.stringify(body, null, 2));
  return EXIT.ok;
}
