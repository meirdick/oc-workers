# Contributing to oc-workers

Terms are in `CONTEXT.md`. Use them.

## Setup

Node 22.18 or later, Docker for the image tests.

```sh
npm ci
```

## Layout

| Path | What |
|---|---|
| `cli/` | The `ochost` CLI. `npm pack` here makes the npm package; it copies `worker/` and `image/` into `cli/templates/`. |
| `worker/` | The Worker: ingress, Control DO, Runtime DO, gates, owner console. |
| `image/` | The container image: Dockerfile, the `ocrt` supervisor, bundled plugins, Docker tests. |
| `docs-site/` | The user docs (Astro, Nimbus). `npm run deploy` publishes them. |

## Checks

```sh
npm run typecheck
npm run lint
npm test                      # worker and cli
cd image/ocrt && node --test test/*.test.mjs
```

The Docker tests under `image/test` need a Docker daemon and take about 20 minutes.

## Rules

- Short sentences, one term per concept. Comments say why, not what.
- A change to the Worker, the image or the CLI comes with a test.
- Commit by path. No secrets in the repo. Install state lives in `.oc-host/` of an install directory, never here.
