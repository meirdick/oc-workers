// R2 bucket name that Litestream puts in the S3 path. One rule for the Control DO plan and ReplicaGate
// (scenario issue I-2): OC_BUCKET, else OC_SETTINGS.bucket, else null (caller uses oc-host-<inst>).
export function bucketName(env: { OC_BUCKET?: string; OC_SETTINGS?: string }): string | null {
  if (env.OC_BUCKET) return env.OC_BUCKET;
  try {
    const s = env.OC_SETTINGS ? (JSON.parse(env.OC_SETTINGS) as { bucket?: unknown }) : null;
    return typeof s?.bucket === "string" && s.bucket ? s.bucket : null;
  } catch {
    return null;
  }
}
