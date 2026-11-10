# Changelog

## 1.2.3

- Fix: The `hello-flood` alert no longer fires on a normal install after about 50 minutes awake. The container's replica proxy proves the replica gate again before an upload when its last proof is over 5 s old, and Litestream uploads about every 15 s, so a normal hour had about 240 hellos. The proxy and ocsup now send a hello MAC that proves the boot secret, and only hellos without it count toward the alert. This needs the new image: run `ochost deploy`, then `ochost restart`. An older image still works; its hellos count as before.
- Backups: while the install is awake and its state changed, the extra archive now runs at most once an hour (was every 15 minutes). Litestream already keeps database loss after a crash to about 1 s; the archive is an extra restore point. The 6 hour archive, the pre-upgrade and owner archives and the daily cap do not change. An install made before 1.2.3 has `"minGapMinutes": 15` in `oc-host.jsonc` and keeps it; to use the new default, set `"minGapMinutes": 60` under `archive` in `oc-host.jsonc` and run `ochost deploy`.

## 1.2.2

- Fix: A Control UI tab left open no longer keeps the install awake. After the idle close, the tab retries its connection and checks `/healthz` about every 15 s. Those requests reset the idle timer, so the install never slept. Now a tab that was idle-closed gets its requests answered without counting as activity and without waking the install. A health check from any tab is not activity either. Reload the tab to use it again.
- Fix: The owner console no longer reloads the whole page every 30 s (every 5 s while the state changes). It now updates the state card and the open tab in place, so the page does not flash, the scroll position stays, and a Setup form you are typing in is not cleared. It skips a refresh while the browser tab is hidden or a form has focus or edits. A login page or an error still causes one full reload.
- Fix: **Sleep now** in the owner console now sleeps the install even if you used it in the last minutes. Before, it refused with `3:idle` until the idle timer ran out, and opening the console counted as use. An open archive, an import or an unsent message still refuses it, with the reason.

## 1.2.1

- Fix: a full disk now shows. While alert `disk-full` is open (95 % used, or an out-of-space error in the container), `ochost status`, `ochost doctor` and the console say the install is degraded, with the reason `disk-full`. Before, status stayed not degraded at 100 % disk. `disk-high` (80 %) is listed with the alerts but does not set degraded. Both alerts close by themselves when the heartbeat shows the disk back under 90 % (`disk-full`) or 80 % (`disk-high`). `ochost status` shows a `disk` row with the last use the container reported.
- Soak engine: `s4-500` waits until the inbox has no pending or held row before its cycles (step `inbox-drain`), and drill-jl waits until the R2 creds copy matches the CredStore before it wipes the Control DO. Each fails with the reason when the wait runs out.

## 1.2.0

- `ochost import <seed-dir>` brings an old OpenClaw install in. `--dry-run` prints the plan. Workspace and `memory/` merge into the workspace; the bootstrap files replace the new defaults (old copies in `.ochost-import/<id>/backup/`), other files the install already has are kept. Records, raw transcripts, media and skills without a target go to file storage (`records/`, `history/`, `media/`; `history/INDEX.json` maps keys to the old names). Cron jobs are re-created with `openclaw cron add --declaration-key`. Config keys that OpenClaw 2026.10.9 has merge into a new version; the rest is listed. Credentials, `.env` files, keys and files that look like they hold a key never leave the laptop. Rules for one old install (vault paths that never copy, dirs that go to file storage, skills to park, cron jobs to skip or turn off, lines for the note) come from an optional local file, `--rules <file.json>`; `ochost import -h` shows the fields. `--feb <dir>` adds an older sessions dir. With the sandbox on, the same merge runs in the sandbox workspace.
- New owner routes: `PUT /ops/import/file`, `PUT /ops/import/bundle`, `GET /ops/import/files` (in the Worker, next to R2), `GET /ops/import`, `POST /ops/import/apply`, `POST /ops/import/sandbox`. New gate routes: `GET /v1/import/bundle`, `POST /v1/import/done`; the heartbeat ack carries `import`. An open import holds the sleep; after 30 min without an answer it fails (`import-stalled`).
- Fix, data loss: a boot that does not use a valid clean marker (PITR, rebase, archive or fresh boot) now voids it. Before, a later crash boot from the same snapshot took the old marker and restored SQLite from before the new gen; rows written since were lost.
- An inbox row that the gateway answers 404 or 501 goes dead after 5 misses and 5 minutes, with alert `inbox-dead` naming the route and status. Before, such rows stayed pending for `inbox.deadHours` (23 h) and held the install awake all that time. A gateway restart (404 for 1-2 min) does not kill rows.
- Fix: `ochost restart` during a sleep no longer leaves the install stopped. The start waits in the op journal while the sleep op runs, survives a Durable Object reset, and runs when the sleep op ends.
- `testTimers` in `oc-host.jsonc` sets the timers (`OC_TIMERS`) of a test install (`OC_TEST=1`), for example a short `l5PendingMs` for a drill. A real install ignores it.
- Soak engine: checks and scripts the M7 soak found wrong are fixed (PITR write count, `pgrep`/`pkill` patterns, creds lag, boot flag, disk fill, drill times). A soak update wakes an asleep test install, and step `r2-mark` measures R2 growth over the plan.
- The Setup tab of the owner console has controls for three toggles. Sandbox: a list (off, on, all) and **Apply**; it saves the choice in the Control DO and restarts the install (no deploy). Alert channel: a URL field with **Save**, **Test** and **Off**; the Control DO keeps the URL and the alert sender uses it before the `ALERT_URL` secret. Model: a list of the models in the config and **Apply**; it posts a new config version and restarts. Each form is one POST and works with JavaScript off. Access stays a command. New ops: `POST /ops/sandbox/set` and `POST /ops/alerts/sink`.
- New alert `no-reply` (warn): a Telegram message accepted 5 minutes ago has no reply while the install runs. Once per hour, with the count. It closes when a reply goes out. The Telegram row in the console and `ochost doctor` shows the count.
- `ochost sandbox on|off --apply` writes the setting, deploys, and restarts.
- The self-test at the end of `ochost init` checks what is true now: the login form at `/`, the Continue page of the owner link, and the session that its POST sets. It no longer warns on a healthy install.
- `ochost restart` right after a deploy no longer asks for a second archive when the newest one finished less than 2 minutes ago and no replica upload came after it finished.
- The `firecrawl` package is not in the image. A config that still names the provider `firecrawl` is rendered as `cloudflare-web-fetch` and its `firecrawl` plugin entry is left out. Run `ochost config render` to write that into your config.
- `ochost model list --refresh` reads every page of the model search (the API gives `total_count`, not `total_pages`; it stopped after the first page).
- Channel setup from the OpenClaw UI. Paste a bot token in Settings > Channels and save. The Worker holds that config (status `held`); the gateway keeps its last good config. The Setup tab shows "token in the UI config, waiting for adoption" with an Adopt button. `ochost channels adopt <telegram|slack|discord|twilio>` does the same. After the owner confirms, the Worker moves the credentials out of the config, rewrites the channel to webhook mode on the managed route, sets the Telegram webhook, accepts the config and restarts the gateway. The row then reads "Telegram: adopted from the UI".
- Adopted credentials are stored in the Control DO's creds store (`adopted/<NAME>`), not as Worker secrets, because a Worker cannot run `wrangler secret put`. They reach the gateway in the start env. A Worker secret of the same name wins.
- Polling mode is refused: the held config says polling keeps the install awake.
- New owner op `POST /ops/channels/adopt {channel}`.
- The agent skill `oc-workers-cloudflare` names the search and `file_store` tools, says where the model list lives and that there is no `openclaw` CLI or `/models` route for the agent. It said there was no web search.
- `sandbox on` sandboxes your Telegram DM too. OpenClaw 2026.10.9 classifies a channel DM by a per-peer policy key for its `non-main` rule, so only the Control UI chat stays on the gateway. The CLI, the config comment and the docs said the main chat was exempt; they now say what happens. Nothing in `init` was wrong.
- Sandboxed sessions keep the `file_store` tool (it runs in the gateway, not in the sandbox). It was missing from the sandbox allow list.
- Console: the cost guard line says "sleep is cheaper, the duty cycle is on" in the normal state (it said "not holding", which read like a fault).
- Alert `archive-failed` closes when a later archive completes. The gateway doctor's own config changes at boot no longer raise `config-sensitive`; the ring row `config-proposal` carries the keys.

## 1.1.1

- One plugin card, "Cloudflare capabilities" (`cf-capabilities`), for web search, web fetch and the browser. It replaces the `cf-web-search` plugin and the `firecrawl` entry. Web fetch has its own provider `cloudflare-web-fetch` that posts to the gate. No API key. The gate has a new `GET /browser/status`. The `firecrawl` package stays in the image for one release. Run `ochost config render` (render version 3) on an older install.
- The `cfgw` provider lists the whole Workers AI chat catalogue (function calling, not deprecated), so you can pick a model in the Control UI or with `/model`. `ochost model list --refresh` updates the snapshot; `ochost model` shows its size and date. Run `ochost config render`.
- The owner console reads the config render version from the newest version that carries it, so a boot where OpenClaw's Doctor rewrote the config no longer shows "config render outdated".
- The file storage plugin card is named "Cloudflare R2 via oc-workers"; OpenClaw's own "Cloudflare" plugin stays off.
- The skill is `oc-workers-cloudflare`; the old `oc-host-cloudflare` dir is removed from the workspace at boot.
- `ochost restart` after a deploy waits up to 5 minutes for the pre-restart archive and gives up after 90 s without progress, naming the request (was a flat 180 s).
- `ochost destroy --delete-data` empties the bucket with an R2 job before it deletes it.
- The main model's thinking level is `agents.defaults.thinkingDefault` (the Control UI's Thinking row), set to `low` only when absent; utility and compaction keep a per-model `off`. The UI row is the one place to change it.

## 1.1.0

New:

- File storage on R2. The agent saves files to the storage location `r2` through the gate, with no credential in the container. Files are durable on write and outside snapshots and archives. New tool `file_store`, `ochost caps set storage <gb>`, a `file storage` row in doctor and the console, `ochost destroy --delete-data` purges them.
- Model roles. The main model thinks at `low`; titles, recaps and compaction run on `@cf/google/gemma-4-26b-a4b-it` with thinking off. The gate passes `reasoning_effort` to Workers AI. `ochost model` shows each role; `ochost model set --role utility|compaction <id>`; `model bench --role`; a deprecated model is refused. Run `ochost config render` on an older install.
- One-shot init. `ochost init` finishes the setup: Telegram and Cloudflare Access from flags or one question each on a fresh install; `--alerts ntfy|webhook`; `--sandbox on` goes in before the first deploy.
- `ochost sandbox on` sandboxes every session except your main chat (OpenClaw mode `non-main`); `on --all` sandboxes every session.

Fixes:

- Sandbox on: web search, web fetch, the browser, memory, media and the message tool work in sandboxed sessions. OpenClaw's sandbox tool policy left them out.
- Speech model is `@cf/deepgram/aura-2-en`; `@cf/myshell-ai/melotts` stops on 2026-11-15.
- `ochost channels add telegram` restarts a running gateway so the bot starts at once.
- `ochost auth access` waits for the Control DO before the restart, ends with a login link, and names the `--team` fix when the token cannot read the organization.
- Token files may be env files (`KEY=value`); `~` in a path expands; known files in `~/.config/oc-host/` are offered as defaults.
- Ops commands run the wrangler the package ships, never `npx`.
- `ochost init` refuses a Worker of the same name that is not an oc-host install.
- The bench shortlist drops two retired models and adds `glm-5.3` and `glm-4.7-flash`.

## 1.0.0

First release. `oc-workers` installs and runs your own OpenClaw assistant on your Cloudflare account with one command, `ochost init`.

- Duty-cycle by default: the container sleeps when idle and wakes on a message, a timer or the Control UI. About $7 to $14 a month at light use.
- No AI token: the model, embeddings, speech, transcription, image and web search run on the Worker's Workers AI binding through an AI Gateway.
- Channels: Telegram (webhook, sleeps), Slack, Discord and Twilio SMS (webhook, sleeps), WhatsApp and the socket channels (always-on).
- Backups: SQLite replicated to R2 while the install runs, archives on a schedule with a verified restore, snapshot chains with rebase and prune.
- Owner console: Overview (cost, alerts, budgets, connected checks, backups), Alerts and log, Setup. Works without JavaScript.
- Capabilities: browser, web fetch, web search, speech, images, with daily budgets and a tool sandbox (off by default).
- Cloudflare Access on a custom domain (`ochost auth access`).
- Upgrades: `ochost upgrade` pins a new OpenClaw image; the next boot runs Doctor and rolls back on a regression.

Not in this release: a landing page, Sandbox bucket mounts for the agent workspace, cold replies under 45 s.
