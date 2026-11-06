#!/bin/bash
# Run a state integration test (image/test/state/*.it.mjs) inside the image, with SeaweedFS 3.80.
# Own network ocst (15.8.0.0/24) and containers ocst-*; does not touch the ocm0/ocm1 harnesses.
# Usage: run-it.sh <test.it.mjs> [extra docker args]. Env: IMG (default oc-m0:dev), KEEP=1.
set -u
D=$(cd "$(dirname "$0")" && pwd)
OCRT=$(cd "$D/../../ocrt" && pwd)
IMG=${IMG:-oc-m0:dev}
T=${1:?test file}
shift
docker rm -f ocst-s3 ocst-it >/dev/null 2>&1
docker network inspect ocst >/dev/null 2>&1 || docker network create --subnet 15.8.0.0/24 ocst >/dev/null
cat >"$D/.s3.json" <<'J'
{"identities":[{"name":"t","credentials":[{"accessKey":"k","secretKey":"s0123456789012345678"}],"actions":["Admin","Read","List","Tagging","Write"]}]}
J
# ANON=1: no s3.config (anonymous), for tests that put a counting proxy in front of S3.
S3CFG=(-s3.config=/etc/s3.json)
[ -n "${ANON:-}" ] && S3CFG=()
docker run -d --name ocst-s3 --network ocst --ip 15.8.0.10 -v "$D/.s3.json":/etc/s3.json:ro \
  chrislusf/seaweedfs:3.80 server -dir=/data -s3 -s3.port=8333 "${S3CFG[@]}" \
  -master.volumeSizeLimitMB=64 -volume.max=40 >/dev/null
docker run --rm --name ocst-it --network ocst --ip 15.8.0.5 -v "$OCRT":/opt/ocrt:ro -v "$D":/it:ro \
  -e S3_ENDPOINT=http://15.8.0.10:8333 "$@" --entrypoint node "$IMG" "/it/$T"
rc=$?
[ -n "${KEEP:-}" ] || { docker rm -f ocst-s3 >/dev/null; docker network rm ocst >/dev/null; rm -f "$D/.s3.json"; }
exit $rc
