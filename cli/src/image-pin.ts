// The OpenClaw base image an install builds from (M6 upgrade). `.oc-host/image.json` holds the pin the last
// upgrade chose and the one before it (rollback). Without the file the Dockerfile defaults apply.
// The pin goes to wrangler as `images.oc.build_vars` (the Dockerfile ARGs BASE, OPENCLAW_VERSION, BASE_DIGEST),
// so a changed pin changes the rendered wrangler.jsonc and with it the deploy hash.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ImagePin {
  /** OpenClaw release, e.g. 2026.10.9 */
  version: string;
  /** base ref with the index digest: ghcr.io/openclaw/openclaw@sha256:<hex> */
  ref: string;
  /** sha256:<hex> of the index */
  digest: string;
}

export interface ImageFile {
  current?: ImagePin;
  /** the pin before `current`; `upgrade rollback` goes back to it */
  previous?: ImagePin;
  /** epoch digest /ops/status showed after the last good upgrade (drift check in `upgrade check`) */
  epochDigest?: string;
  updatedAt?: string;
}

export const IMAGE_REPO = "ghcr.io/openclaw/openclaw";
const FILE = "image.json";

const okPin = (p: unknown): p is ImagePin => {
  const x = p as ImagePin | null;
  return !!x && typeof x.version === "string" && /@sha256:[0-9a-f]{64}$/.test(String(x.ref));
};

export async function readImageFile(stateDir: string): Promise<ImageFile> {
  try {
    const j = JSON.parse(await readFile(join(stateDir, FILE), "utf8")) as ImageFile;
    return {
      ...(okPin(j.current) ? { current: j.current } : {}),
      ...(okPin(j.previous) ? { previous: j.previous } : {}),
      ...(typeof j.epochDigest === "string" ? { epochDigest: j.epochDigest } : {}),
      ...(typeof j.updatedAt === "string" ? { updatedAt: j.updatedAt } : {}),
    };
  } catch {
    return {};
  }
}

export async function writeImageFile(stateDir: string, f: ImageFile): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, FILE), `${JSON.stringify(f, null, 2)}\n`);
}

export function pinOf(version: string, digest: string): ImagePin {
  return { version, ref: `${IMAGE_REPO}@${digest}`, digest };
}

/** The pin in image/Dockerfile: `ARG BASE=<ref>@sha256:…`, version from the header line `…openclaw:<v> …`. */
export async function dockerfilePin(source: string): Promise<ImagePin | null> {
  const f = join(source, "image", "Dockerfile");
  if (!existsSync(f)) return null;
  const t = await readFile(f, "utf8");
  const digest = /^ARG BASE=\S+@(sha256:[0-9a-f]{64})\s*$/m.exec(t)?.[1];
  const version = /^# Default base: \S+:(\d[\w.-]*)/m.exec(t)?.[1];
  return digest && version ? pinOf(version, digest) : null;
}

/** The pin in force: image.json, else the Dockerfile. */
export async function effectivePin(stateDir: string, source: string): Promise<ImagePin | null> {
  return (await readImageFile(stateDir)).current ?? (await dockerfilePin(source));
}

/** Build args for the Dockerfile (docker build --build-arg, wrangler images.oc.build_vars). */
export const buildVarsOf = (p: ImagePin): Record<string, string> => ({
  BASE: p.ref,
  OPENCLAW_VERSION: p.version,
  BASE_DIGEST: p.digest,
});
