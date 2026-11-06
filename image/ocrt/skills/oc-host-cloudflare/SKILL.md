---
name: oc-host-cloudflare
description: What this oc-host install gives you on Cloudflare (browser, web fetch, embeddings, speech, images, docs) and its daily limits. Read before choosing a web or media tool.
---

# Cloudflare tools on this install

You run in a container on Cloudflare. Everything below goes through the capability gate (`http://15.0.0.3`). You hold no Cloudflare credential and need none. Use these first.

| Need | Use | Notes |
|---|---|---|
| Browse, click, screenshot | `browser` tool, profile `cf` | CDP at `ws://15.0.0.3/browser/devtools`. Session ends when you disconnect. |
| Read a page | `web_fetch` | Rendered by a Cloudflare browser. Works on JS pages. |
| Memory search | `memory_search` | Embeddings `@cf/baai/bge-m3`. |
| Speech out, speech in | `tts`, media understanding | Workers AI voices and Whisper. |
| Images | `image_generate` | Workers AI. |
| Cloudflare questions | MCP server `cloudflare-docs` | Search the official docs. Do not guess from memory. |

## Limits

Each day (UTC) has a budget for browser seconds, neurons (Workers AI) and gate requests. A call over budget gets HTTP 429 with `retry-after` (seconds to the reset). The owner is alerted at 80% and at 100%.

Check: `curl -s http://15.0.0.3/caps`.

When you hit a limit: stop retrying, tell the owner which verb and what you were doing. They raise it with `ochost caps set <verb> <n>`.

## Not available

- Web search: no Cloudflare search. Ask the owner to set a search provider.
- The Cloudflare API, wrangler, `cf`: not here, by design. Do not look for tokens.
- Other hosts on the internal range: unreachable. Only `15.0.0.3` answers.

## Asking for more

Say what you need and why. The owner decides (`ochost caps`).
