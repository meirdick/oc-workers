# ochost

`ochost` is the CLI of oc-workers. It installs and runs your own OpenClaw on your own Cloudflare account. The install sleeps when idle, wakes on a message, and costs a few dollars a month.

This is a community project. It is not affiliated with Cloudflare. The full docs are in `docs-site/` and at <https://oc-workers.mdick85.workers.dev>. Terms are in `CONTEXT.md`.

## Install and first run

You need Node 22.18 or later, Docker running, a Cloudflare account on Workers Paid ($5 a month) and a terminal.

1. Get the CLI:

   ```sh
   npm install -g oc-workers
   ```

   This puts `ochost` on your PATH. It can need `sudo`.

2. Log in to Cloudflare:

   ```sh
   npx wrangler login
   ```

3. Install:

   ```sh
   mkdir ~/my-oc && cd ~/my-oc
   ochost init
   ```

`init` asks for no AI token. The model runs on the Worker's Workers AI binding, which uses your account. The first run takes 4 to 5 minutes. Most of that is the image push. At the end, open the Login link. It opens the owner console, and **Open Control UI** opens OpenClaw. A second `ochost init` changes nothing that is current.

For prompts, the model and the AI Gateway, and Telegram, see the [Quickstart](https://oc-workers.mdick85.workers.dev/docs/quickstart/).

## Commands after init

| Command | Does |
|---|---|
| `ochost status` | State, sleep state, last activity, next wake, cost range, model |
| `ochost open` | New single-use login link |
| `ochost sleep now` / `wake` / `restart` | Sleep and wake by hand |
| `ochost channels add telegram` / `list` / `remove telegram` | Manage the bot |
| `ochost pairing list` / `approve telegram <code>` | Approve a direct-message sender |
| `ochost model list` / `set <id>` / `bench` | Choose and test models |
| `ochost config get [path]` / `set <path> <json>` / `pull` | OpenClaw config versions |
| `ochost secrets set <NAME>` / `list` | Extra secrets, seen by the gateway as env `NAME` |
| `ochost backup list` / `create` / `restore <id>` | Archives |
| `ochost doctor` | PASS, WARN and FAIL checks, each with a fix |
| `ochost alerts setup` | Choose where alerts go |
| `ochost auth access --domain <host>` | Put the install behind Cloudflare Access |
| `ochost destroy` | Delete the Worker and image. Keeps the bucket unless `--delete-data`. |

The [CLI reference](https://oc-workers.mdick85.workers.dev/docs/cli-reference/) lists every command and flag. Config and secret changes apply when the gateway starts: at the next wake, or now with `--restart`.

## Scripts and agents

Every command takes `--json`. Stdout is one JSON document, also on failure (`{"ok":false,"error":"Failed: … — fix: …","exit":3}`). Progress goes to stderr, one JSON event per line. `openUrl` is a login link. Treat it as a secret.

Every prompt has a flag. With `--non-interactive`, a missing answer exits 3 and the `fix:` names the step.

```sh
ochost init --non-interactive --json --no-open \
  --account-id <id> --subdomain <name>
```

| Exit | Meaning |
|---|---|
| 0 | OK. WARN lines are allowed. |
| 1 | Failed. |
| 2 | Usage error. |
| 3 | A manual step is needed. `fix:` names it. |
| 4 | The time budget passed. The install can still come up. A rerun is safe. |
| 130 | Interrupted. |

An error is one line: `Failed: <you see> — fix: <do this>`. A warning uses the same shape with `WARN:`. See [Troubleshooting](https://oc-workers.mdick85.workers.dev/docs/troubleshooting/).

## Files

| Path | What | In git |
|---|---|---|
| `oc-host.jsonc` | Your settings. `baseVersion` is the config version you last saw. | yes |
| `openclaw.jsonc` | Copy of the OpenClaw config from `ochost config pull` | yes |
| `.oc-host/wrangler.jsonc` | Generated each run. Never edit. | no |
| `.oc-host/state.json` | URL, inst, account, deploy hash, bot, test-install flag, Access app ids | no |
| `.oc-host/control-token` | Owner token, mode 0600 | no |
| `.oc-host/secrets.json` | Secret names and sha256, never values | no |
| `.oc-host/logs/deploy-*.log` | wrangler output, redacted | no |

## Develop

```sh
npx vitest run cli/test       # from the repo root
npx tsc -p cli
npx biome check cli
```

Tests use a fake wrangler runner, a fake fetch and a fake `/ops` server. They never call Cloudflare.

## Licence

Apache-2.0.
