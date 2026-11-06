# oc-workers

oc-workers installs and runs a persistent [OpenClaw](https://github.com/openclaw/openclaw) assistant on your own Cloudflare account. One command, `ochost init`, sets it up. It is a community project and is not affiliated with Cloudflare.

## How it works

An install is one Worker, some Durable Objects, one container and one R2 bucket on your account. The container runs OpenClaw. By default the container sleeps when idle. It wakes on a chat message, a timer or when you open the Control UI. A sleeping install costs no compute, so light use costs about $7 to $14 a month. A chat channel that needs an open socket keeps the container awake and costs about $50 to $69 a month. State is backed up to R2. Model calls run on Workers AI through your account, so you need no AI token.

## The 5-minute path

You need Node 22.18 or later, Docker running, and a Cloudflare account on Workers Paid.

```sh
npm install -g oc-workers
npx wrangler login
mkdir ~/my-oc && cd ~/my-oc
ochost init
```

Full steps in the [Quickstart](https://oc-workers.mdick85.workers.dev/docs/quickstart/).

## Docs

- [Requirements](https://oc-workers.mdick85.workers.dev/docs/requirements/)
- [Channels](https://oc-workers.mdick85.workers.dev/docs/channels/)
- [Cost](https://oc-workers.mdick85.workers.dev/docs/cost/)
- [CLI reference](https://oc-workers.mdick85.workers.dev/docs/cli-reference/)
- [Troubleshooting](https://oc-workers.mdick85.workers.dev/docs/troubleshooting/)

## Licence

Apache-2.0.
