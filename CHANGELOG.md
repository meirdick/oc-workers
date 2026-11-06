# Changelog

## 1.0.1

- Sandbox on: web search, web fetch, the browser, memory, media and the message tool work again in sandboxed sessions. OpenClaw's sandbox tool policy left them out; the render now allows them (`tools.sandbox.tools.alsoAllow`).
- Speech model is `@cf/deepgram/aura-2-en`. `@cf/myshell-ai/melotts` stops on 2026-11-15.

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
