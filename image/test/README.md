# M1 local harness

Runs the M1 exit tests (scope §4 M1) and the M1 tests of `docs/06-m0-amendments.md` against the image, in local Docker. No Cloudflare account is used.

## Run

```
node image/test/run.mjs --list            # tests and their source
node image/test/run.mjs all              # build oc-m1:test once, env up, every test
node image/test/run.mjs gateway-exit-78 resume-after-sleep
node image/test/run.mjs all --no-build --keep
node image/test/run.mjs --down           # remove every ocm1-* container, volume, snapshot image, the network
node --test image/test/unit/             # harness unit tests
```

Results: `results/<date>/<test>.json` (committed), `results/<date>/summary.md`, logs in `results/<date>/logs/<test>/` (ignored). Status: `pass` (every check ok), `fail`, `blocked` (the image lacks a module the test needs; reason in the JSON), `error`.

Blocked means not wired: `harness/wiring.mjs` reads `/opt/ocrt` in the built image and follows imports from `ocsup.mjs`. A `lib/` module that is not reached (credsync, shadow, diskwatch, guard-boot, config, ...) sets its feature false, and a test with that name in `needs` reports `blocked`. `run.mjs` prints the feature line at start.

`_upgrade-contract` (M6, used by `ochost upgrade run`): base facts, `database preflight` of the candidate on the pinned release's state (must be `exact`), Doctor 0, `/startupz`, lock probe, SIGTERM exit. Docker only:

```
node image/test/run.mjs _upgrade-contract --base ghcr.io/openclaw/openclaw:2026.9.36 \
  --prev-base ghcr.io/openclaw/openclaw@sha256:1a2a3ce113e435039dbeac5ae261759bb4759908563d91c81059e896b38c5d98 \
  --results /tmp/uc          # candidate FROM --base, state written by the --prev-base release
```

`--no-build --image TAG --prev-image TAG` reuses built images. Env `OCM1_UC_VERSION` checks `/app/package.json`.

Probes (name starts with `_`, not in `all`): `_smoke`, `_probe-prepare` (raw `gateway.suspend.prepare`/`resume` answers in a box).

Env: `OCM1_RL_IMAGE` (a recover-lock build), `OCM1_HOG_RUNS`, `OCM1_SEED_WAKES`, `OCM1_IDLE_MIN`, `OCM1_VERBOSE=0`.

## Env (network `ocm1`, 15.0.0.0/24)

| IP | Container | What |
|---|---|---|
| 15.0.0.1 | ocm1-gate | fake ControlGate `:80`, ReplicaGate backend `:8002`, harness API `:9000` (`fakes/gate.mjs`, `fakes/gate-core.mjs`) |
| 15.0.0.2 | ocm1-replica | ReplicaGate address, TCP relay to 15.0.0.1:8002 |
| 15.0.0.10 | ocm1-s3 | SeaweedFS 3.80, anonymous, reached only through the fake ReplicaGate |
| 15.0.0.20 | ocm1-tg | fake Telegram Bot API, TLS with the test CA (`fakes/ext.mjs`) |
| 15.0.0.21 | ocm1-llm | mock LLM (Anthropic Messages, OpenAI Chat) |

The fake gates use `image/ocrt/lib/contract.mjs`: each request and answer is checked with `validate()`; records carry `contract: ok|invalid|unknown-route`. Fault flags (`POST :9000/_ctl/faults`): `hb409`, `hbStatus`, `hbDrop`, `hbStop`, `refuseFinalSnapshot`, `hangFinalSnapshot`, `throttle {delayMs|status|refuseLevel, untilTs}`, `readDelayMs`, `enospc`, `dropRequestWake`, `strict`, `sigv4Strict`, `creds500`, `tier`.

A box (`harness/box.mjs`) is one ocsup container. State stays in the rootfs, so `docker commit` stands in for a snapshot; a wake is a new container from the commit with gen+1 and a new fake boot_id. The harness plays the DO: it sets the gen and the boot plan at the fake before each start and drives sleep phases over `/run/ocrt/ocsupctl.sock`.

The test CA is mounted at `/etc/cloudflare/certs/cloudflare-containers-ca.crt`; `api.telegram.org`, `api.anthropic.com`, `api.openai.com` resolve to the fakes.

M0 scripts (`env-up.sh`, `boot.sh`, `f1-meta.sh`, ...) stay for the M0 record; they use network `ocm0` on the same subnet, so run `env-down.sh` before `run.mjs`.
