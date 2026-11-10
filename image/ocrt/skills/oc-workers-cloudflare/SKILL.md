---
name: oc-workers-cloudflare
description: What this oc-workers install gives you on Cloudflare (browser, web fetch, embeddings, speech, images, docs) and its daily limits. Read before choosing a web or media tool.
---

# Cloudflare tools on this install

You run in a container on Cloudflare. Everything below goes through the capability gate (`http://15.0.0.3`). You hold no Cloudflare credential and need none. Use these first.

| Need | Use | Notes |
|---|---|---|
| Browse, click, screenshot | `browser` tool, profile `cf` | CDP at `ws://15.0.0.3/browser/devtools`. Session ends when you disconnect. |
| Read a page | `web_fetch` | Rendered by a Cloudflare browser. Works on JS pages. |
| Search the web | `web_search` | Provider `cloudflare-web-search` through the gate. |
| Keep a file | `file_store` | Durable files on R2, outside snapshots and backups. save, read, list, delete. Names never overwrite. |
| Memory search | `memory_search` | Embeddings `@cf/baai/bge-m3`. |
| Speech out, speech in | `tts`, media understanding | Workers AI voices and Whisper. |
| Images | `image_generate` | Workers AI. |
| Cloudflare questions | MCP server `cloudflare-docs` | Search the official docs. Do not guess from memory. |

## Limits

Each day (UTC) has a budget for browser seconds, neurons (Workers AI) and gate requests. A call over budget gets HTTP 429 with `retry-after` (seconds to the reset). The owner is alerted at 80% and at 100%.

Check: `curl -s http://15.0.0.3/caps`.

When you hit a limit: stop retrying, tell the owner which verb and what you were doing. They raise it with `ochost caps set <verb> <n>`.

## Models

Your models come from Workers AI through the gate (`/ai/v1`, provider `cfgw`). The list is the `models.providers.cfgw.models` key of your config, chosen by the owner. The gate has no `/models` route and there is no `openclaw` CLI for you here. To change or list models, ask the owner: `ochost model list`, `ochost model set <id>`.

## Not available

- The `openclaw` CLI, `~/.openclaw/tmp/agent-cli`: not here. Config changes go through the owner.
- The Cloudflare API, wrangler, `cf`: not here, by design. Do not look for tokens.
- Other hosts on the internal range: unreachable. Only `15.0.0.3` answers, and only from the gateway container. In a sandboxed session the shell runs in a separate box with no network; the tools above still work, because they run in the gateway.

## Asking for more

Say what you need and why. The owner decides (`ochost caps`).
