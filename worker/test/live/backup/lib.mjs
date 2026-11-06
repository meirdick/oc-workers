// Helpers for the M4 backup drills (worker/test/live/backup-*/run.mjs). Builds on ../lib.mjs; raw files go to
// worker/test/results/raw/M4-backup/ unless RAW is set. env: U, T (CONTROL_TOKEN) of the target install.
import "./env.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export * from "../lib.mjs";

import { asNode, exec, now, ops } from "../lib.mjs";

export const RAWDIR = process.env.RAW;
export const STATE = "/home/node/.openclaw";

/** Per-drill scratch state (between phases of a long drill): <key>/state.json. */
export function loadState(key) {
  try {
    return JSON.parse(readFileSync(join(HERE, "..", key, "state.json"), "utf8"));
  } catch {
    return {};
  }
}
export function saveState(key, s) {
  writeFileSync(join(HERE, "..", key, "state.json"), `${JSON.stringify(s, null, 1)}\n`);
}

/** Run a node ESM snippet as uid 1000 in the container; returns the parsed last stdout line or {err}. */
export async function nodeAs(js, args = [], timeoutMs = 60_000, root = false) {
  const b64 = Buffer.from(js).toString("base64");
  const sh = `echo ${b64} | base64 -d > /tmp/m4b-$$.mjs && /usr/local/bin/node --no-warnings /tmp/m4b-$$.mjs "$@"; rc=$?; rm -f /tmp/m4b-$$.mjs; exit $rc`;
  const cmd = ["sh", "-c", sh, "m4b", ...args.map(String)];
  const r = await exec(root ? cmd : asNode(cmd), timeoutMs);
  try {
    return JSON.parse(
      String(r.stdout ?? "")
        .trim()
        .split("\n")
        .pop(),
    );
  } catch {
    return {
      err: String(r.stderr ?? r.error ?? JSON.stringify(r)).slice(0, 400),
      exit: r.exitCode ?? r.code,
    };
  }
}
/** Shell as root in the container; returns {stdout, stderr, code}. */
export async function sh(cmd, timeoutMs = 60_000) {
  const r = await exec(["sh", "-c", cmd], timeoutMs);
  return {
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? r.error ?? ""),
    code: r.exitCode ?? r.code,
  };
}
export const archives = async (limit = 50) => (await ops("GET", `/ops/archive?limit=${limit}`)).json ?? {};
export const credsManifest = async () => (await ops("GET", "/ops/creds")).json ?? {};
export const ms2s = (ms) => (ms == null ? null : +(ms / 1000).toFixed(1));
export const ago = (t) => (t ? now() - t : null);
