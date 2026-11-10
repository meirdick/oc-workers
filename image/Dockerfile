# oc-host runtime image (plan §4.1; M1).
# Default base: ghcr.io/openclaw/openclaw:2026.10.9 (same index digest as 2026.10.9-slim), pinned by index digest.
#   Found with: docker buildx imagetools inspect ghcr.io/openclaw/openclaw:2026.10.9-slim
#   linux/amd64 manifest: sha256:deab8686a863c1d2255a43bb4677f4907b9af45aff340c062834d16756fd4ff8
# Tools stage is built FROM the same digest, so libjemalloc matches the base glibc (2.36, Debian 12).
# The runtime stage has COPY only, no RUN. Plugins: slack, sms in /opt/oc-plugins (load paths); cf-capabilities and ochost-storage in /app/dist/extensions (image/plugins; COPY, tools stage). slack and sms are npm packed in the tools stage.
# M1 adds: nft + its libs (owner-match rule, scope §1.1 [Z2.4], M0 T2 item 8), the dumpable shim
# /opt/ocrt/nodump.so (T2 item 7; gcc only in the tools stage), ocio helpers. Litestream runs as
# uid 1000 (binary root-owned, 0755).
# Labels come from build args, not from this file (M1-STATUS "hdr"): OPENCLAW_VERSION and BASE_DIGEST
# describe BASE. image/test/run.mjs reads them from the base (label org.opencontainers.image.version,
# repo digest). The tools stage checks OPENCLAW_VERSION against /app/package.json when it is set.
# F-SEC-1: root's PATH has no uid-1000 dir; ENTRYPOINT uses absolute paths.
ARG BASE=ghcr.io/openclaw/openclaw@sha256:1a2a3ce113e435039dbeac5ae261759bb4759908563d91c81059e896b38c5d98
ARG OPENCLAW_VERSION=
ARG BASE_DIGEST=

FROM ${BASE} AS tools
USER root
ARG LITESTREAM_VERSION=0.5.17
# sha256 of litestream-0.5.17-linux-x86_64.tar.gz, from the release checksums.txt.
ARG LITESTREAM_SHA256=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d
ARG NFTABLES_VERSION=1.0.6-2+deb12u2
ARG GCC_VERSION=4:12.2.0-3
# Channel plugins for the webhook channels (docs/14). Not in the base image: without them channels.slack and
# channels.sms have no owner and /slack/events, /webhooks/sms answer 404 (M7 live F2). Baked here so no boot or
# Doctor needs npm; loaded by path. Keep the version equal to the base release.
ARG OPENCLAW_PLUGIN_VERSION=2026.10.9
ARG SLACK_PLUGIN_INTEGRITY=sha512-vKLT1uM1jrvHzZ3HPdGT1RMUm5DVdfjxBLfzRt8AxrQDTZq++G124I67+ck0rVrgj26ktga4uazD/Q46YQIkRQ==
ARG SMS_PLUGIN_INTEGRITY=sha512-sJTu9VkYIi7NO4i2ENswMFmaHvNCxWMjGIJ52J08TPRhM585YWgHVuwCOCcmWvq+U3N885KCjkyDP/TjSSWFbw==
RUN set -eux; \
  ls /usr/lib/x86_64-linux-gnu > /tmp/libs-before; \
  apt-get update; \
  apt-get install -y --no-install-recommends libjemalloc2=5.3.0-1 nftables=${NFTABLES_VERSION} \
    gcc=${GCC_VERSION} libc6-dev; \
  rm -rf /var/lib/apt/lists/*; \
  dpkg-query -W -f='${Version}\n' tini | grep -qx '0.19.0-1+b3'; \
  curl -fsSL -o /tmp/ls.tgz \
    "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz"; \
  echo "${LITESTREAM_SHA256}  /tmp/ls.tgz" | sha256sum -c -; \
  tar -xzf /tmp/ls.tgz --no-same-owner -C /usr/local/bin litestream; \
  rm /tmp/ls.tgz; \
  litestream version | grep -qx "${LITESTREAM_VERSION}"; \
  mkdir -p /out/lib /out/sbin; \
  cp /usr/sbin/nft /out/sbin/nft; \
  for l in $(ldd /usr/sbin/nft | awk '$3 ~ /^\// {print $3}'); do \
    b=$(basename "$l"); grep -qx "$b" /tmp/libs-before || cp -L "$l" "/out/lib/$b"; \
  done; \
  ls /out/lib; \
  chown root:root /usr/local/bin/litestream; chmod 0755 /usr/local/bin/litestream
# Slack and SMS bundle their dependencies too. Same version as the base release (OPENCLAW_PLUGIN_VERSION).
RUN set -eux; mkdir -p /tmp/ch; cd /tmp/ch; \
  for p in "slack ${SLACK_PLUGIN_INTEGRITY}" "sms ${SMS_PLUGIN_INTEGRITY}"; do \
    set -- $p; mkdir -p "/opt/oc-plugins/$1"; \
    npm pack --silent "@openclaw/$1@${OPENCLAW_PLUGIN_VERSION}" > name; \
    got="sha512-$(openssl dgst -sha512 -binary "$(cat name)" | openssl base64 -A)"; \
    [ "$got" = "$2" ] || { echo "$1 plugin integrity $got" >&2; exit 1; }; \
    tar -xzf "$(cat name)" --no-same-owner --strip-components=1 -C "/opt/oc-plugins/$1"; \
    test -f "/opt/oc-plugins/$1/openclaw.plugin.json"; \
  done; \
  test -d /opt/oc-plugins/slack/node_modules/@slack/bolt; test -d /opt/oc-plugins/sms/node_modules/zod; \
  rm -rf /tmp/ch
# docs/11 §11: web search, web fetch and browser status in one plugin (was cf-web-search). Plain ESM, no dependency.
COPY plugins/cf-capabilities/ /opt/oc-bundled/cf-capabilities/
# docs/11 §8: storage provider ochost-r2 and the file_store tool (R2 through the gate). Plain ESM, no dependency.
COPY plugins/ochost-storage/ /opt/oc-bundled/ochost-storage/
COPY ocrt/ /opt/ocrt/
COPY probe.sh /opt/ocrt/probe.sh
COPY native/nodump.c /tmp/nodump.c
RUN gcc -shared -fPIC -O2 -Wall -Werror -o /opt/ocrt/nodump.so /tmp/nodump.c && \
  chmod 0755 /opt/ocrt/probe.sh && chmod -R a+rX,go-w /opt/ocrt /opt/oc-plugins /opt/oc-bundled && chown -R root:root /opt/oc-plugins /opt/oc-bundled
# The bundled plugins import `openclaw/plugin-sdk/*`. The CLI (`openclaw infer web fetch`) loads it with plain Node, which
# needs /app/node_modules/openclaw; the base has none (M8 live: "Cannot find package 'openclaw'"). A symlink to /app.
RUN mkdir -p /opt/oc-nm && ln -s /app /opt/oc-nm/openclaw
# Label check last, so a new value does not rebuild the apt and gcc layers.
ARG OPENCLAW_VERSION
RUN set -eu; v=$(/usr/local/bin/node -p 'require("/app/package.json").version'); \
  if [ -n "${OPENCLAW_VERSION}" ] && [ "$v" != "${OPENCLAW_VERSION}" ]; then \
    echo "OPENCLAW_VERSION=${OPENCLAW_VERSION} but base /app/package.json has $v" >&2; exit 1; fi

FROM ${BASE}
COPY --from=tools /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=tools /usr/lib/x86_64-linux-gnu/libjemalloc.so.2 /usr/lib/x86_64-linux-gnu/libjemalloc.so.2
COPY --from=tools /usr/bin/tini /usr/bin/tini
COPY --from=tools /out/sbin/nft /usr/sbin/nft
COPY --from=tools /out/lib/ /usr/lib/x86_64-linux-gnu/
COPY --from=tools /opt/ocrt /opt/ocrt
COPY --from=tools /opt/oc-plugins /opt/oc-plugins
# cf-capabilities and ochost-storage are bundled extensions: a plugin loaded by path is untrusted and slows boot ~6 s (docs/13).
COPY --from=tools /opt/oc-bundled/ /app/dist/extensions/
COPY --from=tools /opt/oc-nm/ /app/node_modules/
USER root
ENV OPENCLAW_NO_AUTO_UPDATE=1
# Base PATH minus /home/node/.local/bin (uid-1000 owned; F-SEC-1). Every dir here is root 0755.
# ocsup sets its own PATH to /usr/sbin:/usr/bin:/sbin:/bin at start (lib/bins.mjs).
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ARG OCSUP_SHA=dev
ARG OPENCLAW_VERSION
ARG BASE_DIGEST
LABEL org.opencontainers.image.title="oc-host-runtime" \
  oc-host.openclaw.version="${OPENCLAW_VERSION}" \
  oc-host.base.digest="${BASE_DIGEST}" \
  oc-host.base.os="debian-12" \
  oc-host.base.glibc="2.36" \
  oc-host.litestream="0.5.17" \
  oc-host.nftables="1.0.6-2+deb12u2" \
  oc-host.ocsup.sha="${OCSUP_SHA}" \
  oc-host.ocsup.pv="1"
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/node", "--max-old-space-size=256", "/opt/ocrt/ocsup.mjs"]
CMD []
