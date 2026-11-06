// Image push to registry.cloudflare.com: classify a failed `wrangler deploy` and retry the known flakes.
// Copied from cf-orbs cli/src/wrangler.ts (classifyDeployFailure, deployWithRetry) with one more retry
// classes: "blob unknown to registry" (M0 T7f items 4 and 11; spec 10 §2.2), "connection reset by peer", "broken pipe".
import { CliError, EXIT } from "./ui.ts";
import { lastLine, type Wrangler } from "./wrangler.ts";

export type DeployFailure = "retry" | "paid" | "docker" | "auth" | "subdomain" | "other";

const PUSH_MARKERS =
  /Pushed|Layer already exists|already exists remotely|Preparing .* for Cloudflare Containers|registry\.cloudflare\.com/;

/** Why a retryable deploy failed, as the progress line says it. undefined = not a registry flake. */
export function retryReason(output: string): string | undefined {
  if (/timeout awaiting response headers/i.test(output)) return "registry push timed out";
  if (/blob unknown to registry|BLOB_UNKNOWN/i.test(output)) return "blob unknown";
  // A long push dies on a dropped socket (dogfood row 36: 10 min in, "write tcp ...: connection reset by peer").
  if (/connection reset by peer/i.test(output)) return "connection reset";
  if (/broken pipe/i.test(output)) return "broken pipe";
  if (/Unauthorized/.test(output) && PUSH_MARKERS.test(output)) return "image preparation returned 401";
  return undefined;
}

export function classifyDeployFailure(output: string): DeployFailure {
  if (retryReason(output)) return "retry";
  if (
    /workers paid|paid plan|upgrade your plan|not entitled|entitlement|containers? (?:is|are) not (?:enabled|available)/i.test(
      output,
    )
  )
    return "paid";
  if (
    /Cannot connect to the Docker daemon|docker: command not found|The Docker CLI could not be launched|is docker running/i.test(
      output,
    )
  )
    return "docker";
  if (/not logged in|wrangler login|Authentication error|code: 10000\b/i.test(output)) return "auth";
  if (/workers\.dev subdomain/i.test(output)) return "subdomain";
  return "other";
}

/** One-line error for a deploy failure (spec 10 §5). */
export function deployFailureError(kind: DeployFailure, output: string, logFile?: string): CliError {
  const log = logFile ? ` (full log: ${logFile})` : "";
  switch (kind) {
    case "paid":
      return new CliError(
        "account is not on Workers Paid",
        "upgrade at https://dash.cloudflare.com/?to=/:account/workers/plans ($5/month), then rerun",
        EXIT.manual,
      );
    case "docker":
      return new CliError("Docker is not running", "start Docker, check docker info, then rerun");
    case "auth":
      return new CliError(
        "wrangler is not logged in",
        "run npx wrangler login, then rerun ochost init",
        EXIT.manual,
      );
    case "subdomain":
      return new CliError("no workers.dev subdomain", "rerun with --subdomain <name>", EXIT.manual);
    case "retry":
      return new CliError(
        "image push kept failing (3 retries)",
        `rerun ochost deploy; pushed layers are kept${log}`,
      );
    default:
      return new CliError(
        `wrangler deploy failed: ${lastLine(output)}${log}`,
        "fix the error above, then rerun ochost deploy",
      );
  }
}

export interface DeployResult {
  attempts: number;
  output: string;
}

/**
 * `wrangler deploy` with retries for the registry flakes: up to `retries` more attempts, 5 s × attempt apart.
 * Never retries Workers Paid, Docker, auth or subdomain failures.
 */
export async function deployWithRetry(
  w: Wrangler,
  args: string[],
  o: {
    retries?: number;
    onOutput?: (s: string) => void;
    onRetry?: (attempt: number, why: string) => void;
    sleep?: (ms: number) => Promise<void>;
    logFile?: string;
  } = {},
): Promise<DeployResult> {
  const retries = o.retries ?? 3;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    const r = await w.run(["deploy", ...args], { onOutput: o.onOutput, timeoutMs: 30 * 60_000 });
    const output = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0) return { attempts: attempt, output };
    const kind = classifyDeployFailure(output);
    if (kind === "retry" && attempt <= retries) {
      o.onRetry?.(attempt, retryReason(output) ?? "registry flake");
      await sleep(5_000 * attempt);
      continue;
    }
    throw deployFailureError(kind, output, o.logFile);
  }
}

/** Deploy phase from wrangler output, for the progress line. */
export function deployPhase(output: string): string {
  const tail = output.slice(-4000);
  const marks: [RegExp, string][] = [
    [/Current Version ID|Deployed .* triggers/i, "deployed"],
    [/Uploaded |Uploading /i, "uploading Worker"],
    [/Pushed|Pushing|Preparing .* for Cloudflare Containers|registry\.cloudflare\.com/i, "pushing image"],
    [/Building image|\[\+\] Building|#\d+ \[/i, "building image"],
  ];
  let best = "starting wrangler";
  let at = -1;
  for (const [re, name] of marks) {
    const m = [...tail.matchAll(new RegExp(re.source, "gi"))].pop();
    if (m?.index !== undefined && m.index > at) {
      at = m.index;
      best = name;
    }
  }
  return best;
}
