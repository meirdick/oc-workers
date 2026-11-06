# SandboxSession image (docs/12 §3): the container where the agent's exec and file tools run.
# Needs what OpenClaw's remote-shell backend uses (/bin/sh, python3, GNU stat/readlink, tar, coreutils
# timeout) plus sandbox-shim for DirectoryBackup (@cloudflare/sandbox requirement; tag = package version).
# No /workspace in the image: DirectoryBackup.restore() cannot replace an image dir under wrangler dev (EXDEV).
FROM node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 git curl ca-certificates procps jq unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker.io/cloudflare/sandbox:1.0.3@sha256:fc1740c3cba26461f0ab1771287c84018ab2cca43a70ebb823087c85d780aaec \
  /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
LABEL org.opencontainers.image.title="oc-host-sandbox" oc-host.sandbox-sdk="1.0.3"
CMD ["sleep", "infinity"]
