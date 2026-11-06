# Changelog

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
