#!/usr/bin/env node
// ochost entry. Runs dist/ochost.mjs; builds it from src/ with esbuild when missing or older than src/
// (a source checkout). The npm package ships dist/ prebuilt and templates/ (the Worker and image sources).
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "ochost.mjs");
const src = join(root, "src");

function stale() {
  if (!existsSync(out)) return true;
  if (!existsSync(src)) return false;
  const built = statSync(out).mtimeMs;
  return readdirSync(src).some((f) => statSync(join(src, f)).mtimeMs > built);
}

// A source checkout rebuilds with esbuild (a dev dependency). The npm package ships dist/ and has no esbuild.
const canBuild = await import("esbuild").then(
  () => true,
  () => false,
);
if (stale() && canBuild) {
  const { build } = await import("esbuild");
  await build({
    entryPoints: [join(src, "index.ts")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    logLevel: "error",
  });
}

const { main } = await import(pathToFileURL(out).href);
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(
      `Failed: ${e?.message ?? e} — fix: rerun with OCHOST_DEBUG=1 and report the output\n`,
    );
    process.exitCode = 1;
  },
);
