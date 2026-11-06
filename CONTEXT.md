# Context: ubiquitous language

Use these terms in code, docs, commits and chat. Source: `docs/01-plan.md` §3.1, `docs/04-addendum-duty-cycle.md` §2.

| Term | Meaning |
|---|---|
| install | One oc-host deployment on one owner's Cloudflare account: Worker, Control DO, Runtime DOs, R2 bucket `oc-host-<inst>`. Id `<inst>`. |
| owner | The one human who controls an install. Auth is the owner cookie or `CONTROL_TOKEN`; no other users (D4). |
| Control DO | Durable Object `ctl:<inst>`, no container. The stable control point: epoch pointer, gen table, CredStore, config, op journal, inbox, alerts. |
| Runtime DO | Durable Object `rt:<inst>:e<N>`, one per epoch. Owns `ctx.container`, its state machine, `monitor()`, the 60 s alarm, the proxy and WS bridge. |
| epoch | One image key plus one Worker code version. Each epoch has its own Runtime DO. One epoch is active per install. |
| gen | Litestream generation, path `r/<inst>/g<gen>/`. Each `start()` gets a new gen; gens are never reused. Fences split-brain. |
| ocsup | Supervisor in the container, PID 1 child under tini, root. Restore, cgroups, Litestream, gateway, heartbeat, sleep phases (`ocsupctl`). |
| ocio | Helper run as uid 1000 that does all file I/O in uid-1000 trees for ocsup. Root never opens those paths. |
| ControlGate | WorkerEntrypoint at `15.0.0.1:80`. Narrow authenticated API from ocsup to the Control DO: hello, boot, heartbeat, creds, config, archives. |
| ReplicaGate | WorkerEntrypoint at `15.0.0.2:80`. S3 subset for Litestream: checks SigV4 per-boot keys, writes only to the current gen via the R2 binding, records uploads. |
| inbox | Control DO table that stores and acks each webhook update (Telegram) before the container is up. Row states: pending, held, accepted, replicated, dead. |
| duty-cycle | Default mode (`sleep.mode: auto`). The container sleeps when idle and wakes on webhook, cron or UI. Always-on only when a socket needs it. |
| wake | A new `start()` from a sleep snapshot. Gets a new gen. |
| sleep op | Runtime DO op `sleep`: journaled, phase-resumable steps (check, quiesce, flush, marker, snapshot, stop). Any phase before the snapshot can abort. |
| clean marker | Single-use record, written only after a confirmed final flush on the sleep or planned-stop path. Consumed once in `beginBoot`; voided on any abort. Lets a wake skip the gen restore. |
| CapGate | WorkerEntrypoint at `15.0.0.3:80`, reachable by uid 1000 (like SandboxGate). Browser, web fetch and AI media routes with per-verb daily budgets in the Control DO. No credential in the container (docs/11). |
| SandboxGate | WorkerEntrypoint at `15.0.0.4:80`. `POST /exec` for the OpenClaw backend `ochost`; checks on, gen and the exec and sandbox budgets, then forwards to SandboxSession (docs/12). |
| SandboxSession | DO `sb:<inst>` with its own container (Sandbox SDK 1.0). Runs the agent's exec and file tools when `sandbox` is on; backs up `/workspace` to R2 on sleep. |
| SoakPlan | Named list of fault and check steps the Control DO alarm runs on a test install (`OC_TEST=1`), results in R2 `results/<plan>/`. `docs/17-soak-engine.md`. |
