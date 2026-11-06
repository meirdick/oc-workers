// CODE_VERSION (spec 08 §2.2, scope [Z2.13]): sha256 of the bundled Runtime DO + gate + core sources,
// injected at build with `wrangler deploy --define __CODE_VERSION__:"<hex>"` (scripts/code-version.mjs).
// Not CF_VERSION.id: that changes on every deploy, even when the DO code does not.
declare const __CODE_VERSION__: string | undefined;

export const CODE_VERSION: string = typeof __CODE_VERSION__ === "string" ? __CODE_VERSION__ : "dev";

/**
 * O1: the epoch digest from a deployed image reference (`ctx.container` images map value, set by
 * `wrangler deploy`). `repo@sha256:<hex>` → `sha256:<hex>`; `registry/acct/repo:tag` → `repo:tag`. The plan
 * field `rootfs.digest` allows 80 chars, so longer values keep their tail. Empty → null (keep the epoch's).
 */
export function imageDigestOf(ref: string | undefined | null): string | null {
  if (!ref) return null;
  const at = ref.indexOf("@");
  const d = at >= 0 ? ref.slice(at + 1) : ref.slice(ref.lastIndexOf("/") + 1);
  if (!d) return null;
  return d.length > 80 ? d.slice(-80) : d;
}
