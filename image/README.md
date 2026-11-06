# M0 image and ocsup prototype

Runtime image for M0 tests (plan §4.1) and a prototype of ocsup (plan §4). Not prod code.

## Contents

| Path | What |
|---|---|
| `Dockerfile` | Tools stage + runtime stage. Base `ghcr.io/openclaw/openclaw@sha256:1a2a3ce1…5d98` (2026.10.9 = 2026.10.9-slim). Runtime stage is COPY only. |
| `ocrt/ocsup.mjs` | Supervisor. Plain Node ESM, no deps. Runs as root under `tini -s`. |
| `ocrt/lib/s3.mjs` | SigV4 signer, ListObjectsV2, CreateBucket. |
| `ocrt/unpreload.mjs` | Gateway `--import`: deletes `LD_PRELOAD` and `MALLOC_CONF`. |
| `ocrt/dumpable-check.mjs` | T2 item 7 check, used by `probe.sh`. |
| `probe.sh` | T2 probe. Copied to `/opt/ocrt/probe.sh`. |
| `test/` | Local harness: fake ControlGate at 15.0.0.1, SeaweedFS S3 at 15.0.0.10, boot/lock/restore/fence scripts. |

## Pins

- OpenClaw 2026.10.9, index digest `sha256:1a2a3ce113e435039dbeac5ae261759bb4759908563d91c81059e896b38c5d98`, linux/amd64 manifest `sha256:deab8686a863c1d2255a43bb4677f4907b9af45aff340c062834d16756fd4ff8`.
- Litestream 0.5.17, `litestream-0.5.17-linux-x86_64.tar.gz` sha256 `cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d` (release `checksums.txt`). Checked by `sha256sum -c` in the build.
- libjemalloc2 5.3.0-1 (Debian 12). tini 0.19.0-1+b3 (in the base; the build checks the version).

## ocsup env

| Var | Default | Use |
|---|---|---|
| `OCRT_INST`, `OCRT_EPOCH`, `OCRT_GEN` | m0, 1, 1 | Identity. Replica prefix `r/<inst>/g<gen>/`. |
| `OCRT_RESTORE_GEN` | `OCRT_GEN` | Gen to restore from. |
| `OCRT_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | none | Litestream target. No endpoint: no restore, no Litestream. |
| `OCRT_GATE_URL` | `http://15.0.0.1` | Heartbeat, events, final snapshot. |
| `OCRT_BOOT_SECRET` | none | Bearer on gate calls. |
| `OCRT_HB_MS`, `OCRT_HB_FAIL_MAX`, `OCRT_FENCE` | 30000, 3, 0 | `OCRT_FENCE=1`: exit 77 after N failed heartbeats. A 409 always gives exit 77. |
| `OCRT_HOSTNAME` | `localhost` | Hostname pin (plan §4.3). |
| `OCRT_DOCTOR` | 0 | 1: run `doctor --fix --non-interactive` as uid 1000 after the lock step. |
| `OCRT_LOCK_MODE` | auto | `none` skips recover-lock. |
| `OCRT_SUSPEND_ON_TERM` | 1 | Call `gateway.suspend.prepare` before the gateway SIGTERM. |
| `OCRT_JEMALLOC` | 1 | Preload jemalloc into the gateway only. |
| `OCRT_GW_ARGS` | `--allow-unconfigured --bind lan --port 18789 --auth token` | Gateway args. |
| `OC_*` | | Passed to the gateway (SecretRef env). `OC_GATEWAY_TOKEN` is also set as `OPENCLAW_GATEWAY_TOKEN`. All `OCRT_*`, `OC_*`, `AWS_*` are removed from ocsup's own env. |
| `OCRT_TEST_FAKE_BOOT_ID` | none | Local tests only: bind-mounts a value over `/proc/sys/kernel/random/boot_id`. |

## Boot order

boot_id → hostname pin → cgroups → oom_score_adj, ptrace_scope → restore (only if no managed DB on disk and the gen prefix has data) → lock step (reap, read locks and lease as uid 1000, classify, recover-lock if the release has it) → Doctor (optional) → Litestream (DB set rescan every 10 s) → gateway.

## Faults

Write lines to `/var/lib/ocrt/faults`: `kill-gateway`, `kill-litestream`, `balloon-vm <MiB>`, `balloon-gw <MiB>`, `balloon-stop`, `exit <code>`, `hang-sigterm`, `heartbeat-off`, `heartbeat-on`. ocsup reads the file every 1 s and renames it to `faults.<ts>.done`.

## Files

`/var/lib/ocrt/ocsup.log` (JSON lines, 5 MB ring, one `.1`), `/var/lib/ocrt/status.json`, `/var/lib/ocrt/boot_id`, `/run/ocrt/boot.json`, `/run/ocrt/litestream.yml` (0600).

## Exit codes (plan §5.5)

0 SIGTERM drain or pre-start abort. 70 `supervisor`, `reap-failed:*`, `gateway-crash-loop`. 75 `restore-blocked:infra|mismatch`. 77 `stale`, `fenced:heartbeat-lost`. 78 `doctor-failed`, `lock-blocked`, `ownership`.

## Local tests

```
docker build -t oc-m0:dev image/
image/test/env-up.sh
image/test/matrix.sh   # boot times
image/test/lock.sh     # lock reclaim after SIGKILL
image/test/restore.sh  # Litestream restore
image/test/fence.sh    # heartbeat fence
image/test/env-down.sh
(cd image && npx biome check . && npx vitest run --root ocrt)
```

## Local results (2026-10-31, docker 29.9.2, 16-core host, --memory 6g, privileged + cgroupns private)

Boot to `/startupz` (host clock from `docker run`), fresh state, 3 runs each, median:

| | 1 CPU | 2 CPU |
|---|---|---|
| ocsup, no Doctor | 8.78 s | 5.51 s |
| ocsup, Doctor | 23.44 s | 13.97 s |
| stock image, no Doctor (2 runs) | 8.74 s | 5.57 s |
| stock entrypoint, Doctor (2 runs) | 20.55 s | 14.02 s |

Other results:

- SIGTERM drain: 18.7-23.4 s with Litestream; the gateway close waits 10.05 s on `plugin-state-database` while Litestream runs. Without Litestream: 4.3 s. `suspend.prepare` adds 0.66-0.68 s.
- Lock after SIGKILL, pinned hostname, new boot_id: no wait, 5.8 s. Different hostname: 2026.10.9 gateway exits 1 at once; ocsup waits for heartbeat age 95 s; 86.0 s.
- In-container gateway kill to `/startupz`: 7.0 s, no wait.
- Restore of 2 DBs: 172 ms; then `/startupz` in 5.6 s, no lock wait.
- Fence: exit 77 after 3 failed heartbeats (11.6 s at 3 s interval); exit 77 at once on 409.
- `setpriv` aborts (SIGABRT) with jemalloc preloaded; ocsup sets `LD_PRELOAD` after the uid drop.
- cgroup delegation: chown of the leaf `cgroup.procs` only is not enough; the common parent needs it too.
