#!/bin/bash
# Local M0 test env: docker network ocm0 (15.0.0.0/24), fake ControlGate at 15.0.0.1, SeaweedFS S3 at 15.0.0.10:8333.
# MinIO images are not pullable here (Docker Hub repo gone, quay.io 401), so SeaweedFS 3.80 stands in for R2.
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd)
IMG=${IMG:-oc-m0:dev}
docker network inspect ocm0 >/dev/null 2>&1 || docker network create --subnet 15.0.0.0/24 --gateway 15.0.0.254 ocm0 >/dev/null
docker volume create ocm0-gatelog >/dev/null
docker rm -f ocm0-gate ocm0-s3 >/dev/null 2>&1 || true
docker run -d --name ocm0-gate --network ocm0 --ip 15.0.0.1 -v "$D":/t:ro -v ocm0-gatelog:/log \
  --entrypoint node "$IMG" /t/fake-gate.mjs >/dev/null
cat >"$D/.s3.json" <<'J'
{"identities":[{"name":"ocrt","credentials":[{"accessKey":"ocrtkey","secretKey":"ocrtsecret0123456789"}],"actions":["Admin","Read","List","Tagging","Write"]}]}
J
docker run -d --name ocm0-s3 --network ocm0 --ip 15.0.0.10 -v "$D/.s3.json":/etc/s3.json:ro \
  chrislusf/seaweedfs:3.80 server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/s3.json \
  -master.volumeSizeLimitMB=64 -volume.max=20 >/dev/null
for i in $(seq 1 60); do
  if docker run --rm --network ocm0 --entrypoint node "$IMG" -e '
    const s3=await import("/opt/ocrt/lib/s3.mjs");
    const c={endpoint:"http://15.0.0.10:8333",bucket:"oc-m0",region:"us-east-1",accessKey:"ocrtkey",secretKey:"ocrtsecret0123456789"};
    console.log("create-bucket", await s3.createBucket(c)); console.log("list", (await s3.listKeys(c,"")).length);' \
    --input-type=module 2>/dev/null; then echo "env up"; exit 0; fi
  sleep 1
done
echo "s3 not ready" >&2; exit 1
