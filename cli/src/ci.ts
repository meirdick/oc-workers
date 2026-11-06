// ochost ci setup [--repo owner/name] [--force] (docs/10-cli-spec.md §1.2, §2.3 [chg]: CI_TOKEN only here).
// Writes .github/workflows/oc-host.yml (an out-of-band dead-man: GET /ops/status with the CI token every 30
// min; a failed run mails the repo owner), mints CI_TOKEN (Worker secret), sets the repo secret and the URL
// variable with gh, posts POST /ops/ci, then checks that the CI token is live.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CliError,
  EXIT,
  type FlagSpec,
  flagBool,
  flagStr,
  type OpsCtx,
  oneLine,
  opsClient,
  putSecret,
  randomHex,
  redact,
  registerSecret,
  usage,
} from "./ops-lib.ts";

export const ciFlags: FlagSpec = {
  repo: { type: "string" },
  force: { type: "boolean" },
};

export const WORKFLOW_PATH = ".github/workflows/oc-host.yml";

export function workflowYaml(): string {
  return `# Written by ochost ci setup. Out-of-band dead-man for the oc-host install: a failed run means the
# Worker did not answer, or the install reports a problem. GitHub mails the repo owner on failure.
name: oc-host
on:
  schedule:
    - cron: "17,47 * * * *"
  workflow_dispatch: {}
permissions: {}
jobs:
  deadman:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: GET /ops/status (never wakes the install)
        env:
          OC_HOST_URL: \${{ vars.OC_HOST_URL }}
          OC_HOST_CI_TOKEN: \${{ secrets.OC_HOST_CI_TOKEN }}
        run: |
          set -eu
          code=$(curl -sS -o status.json -w '%{http_code}' --max-time 30 \\
            -H "Authorization: Bearer $OC_HOST_CI_TOKEN" "$OC_HOST_URL/ops/status")
          echo "http $code"
          test "$code" = 200
          jq -r '"state \\(.state) · ctl \\(.ctlState) · open alerts \\(.alerts | length)"' status.json
          test "$(jq -r '.ctlState' status.json)" = ok
          test "$(jq -r '.state' status.json)" != restore-blocked
          curl -sS -o /dev/null --max-time 30 -X POST -H "Authorization: Bearer $OC_HOST_CI_TOKEN" \\
            -H "content-type: application/json" -d "{\\"deadman\\":\\"ok\\",\\"run\\":\\"$GITHUB_RUN_ID\\"}" \\
            "$OC_HOST_URL/ops/ci"
`;
}

async function repoOf(ctx: OpsCtx): Promise<string> {
  const given = flagStr(ctx.args, "repo");
  if (given) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(given)) throw usage("--repo must be owner/name", "pass --repo owner/name");
    return given;
  }
  const r = await ctx.run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    cwd: ctx.dir,
  });
  const name = r.stdout.trim();
  if (r.code !== 0 || !name)
    throw new CliError(
      "no GitHub repo found here",
      "rerun with --repo owner/name, or run gh auth login",
      EXIT.manual,
    );
  return name;
}

export async function ci(ctx: OpsCtx): Promise<number> {
  const sub = ctx.args.positionals[0];
  if (sub !== "setup") throw usage(`unknown ci command ${sub ?? ""}`.trim(), "use ochost ci setup");
  const ops = opsClient(ctx);
  const repo = await repoOf(ctx);
  const wf = join(ctx.dir, WORKFLOW_PATH);
  let wrote = false;
  let existing: string | null = null;
  try {
    existing = readFileSync(wf, "utf8");
  } catch {}
  if (existing === null || flagBool(ctx.args, "force")) {
    mkdirSync(dirname(wf), { recursive: true });
    writeFileSync(wf, workflowYaml());
    wrote = true;
  } else if (existing !== workflowYaml())
    ctx.out.warn(
      `${WORKFLOW_PATH} exists and differs, so it was kept — fix: ochost ci setup --force writes it`,
    );
  const token = randomHex(32);
  registerSecret(token);
  ctx.out.step("setting CI_TOKEN on the Worker (wrangler)");
  await putSecret(ctx, ops.install, "CI_TOKEN", token);
  const gh = async (args: string[], input?: string) => {
    const r = await ctx.run("gh", args, { input, cwd: ctx.dir });
    if (r.code !== 0)
      throw new CliError(
        `gh ${args.slice(0, 2).join(" ")} failed: ${oneLine(redact(r.stderr)).slice(0, 160)}`,
        "run gh auth login, then rerun ochost ci setup",
      );
  };
  ctx.out.step(`setting repo secret OC_HOST_CI_TOKEN and variable OC_HOST_URL on ${repo}`);
  await gh(["secret", "set", "OC_HOST_CI_TOKEN", "--repo", repo], token);
  await gh(["variable", "set", "OC_HOST_URL", "--repo", repo, "--body", ops.install.url]);
  await ops.call("POST", "/ops/ci", { setup: true, repo, at: ctx.now() });
  // The secret change makes a new Worker version; wait until the CI token works.
  const ciOps = opsClient(ctx, { ...ops.install, token });
  const t0 = ctx.now();
  let live = false;
  while (ctx.now() - t0 < 60_000) {
    const r = await ciOps.call("GET", "/ops/status", undefined, { allow: [200, 404] }).catch(() => null);
    if (r?.status === 200) {
      live = true;
      break;
    }
    await ctx.sleep(2000);
  }
  if (!live)
    ctx.out.warn("the CI token did not work in 60 s — fix: wait 1 min, then gh workflow run oc-host");
  if (ctx.out.json)
    ctx.out.result({ ok: true, repo, workflow: WORKFLOW_PATH, wroteWorkflow: wrote, ciTokenLive: live });
  else {
    ctx.out.line(`CI dead-man set on ${repo}`);
    ctx.out.line(`next: commit ${WORKFLOW_PATH} and push; gh workflow run oc-host runs it once`);
  }
  return EXIT.ok;
}
