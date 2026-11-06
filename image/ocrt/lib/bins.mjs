// Absolute paths for every binary root runs, and root's fixed PATH (security review F-SEC-1).
// uid 1000 owns /home/node; the base image PATH starts with /home/node/.local/bin. A bare name in a
// root spawn would run a uid-1000 file as root. Node resolves the executable with the PARENT's PATH,
// not options.env.PATH, so ocsup also sets its own PATH to SAFE_PATH at start (ocsup.mjs).
// Paths are Debian 12 (merged /usr) in the OpenClaw base; litestream and node are in /usr/local/bin
// (root 0755). Leaf module: no imports.

/** Root's PATH. No uid-1000-writable dir (scope §1.1 "Image"; review F-SEC-1). */
export const SAFE_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";

export const BIN = Object.freeze({
  sh: "/bin/sh",
  setpriv: "/usr/bin/setpriv",
  env: "/usr/bin/env",
  hostname: "/usr/bin/hostname",
  sync: "/usr/bin/sync",
  mount: "/usr/bin/mount",
  fallocate: "/usr/bin/fallocate",
  nft: "/usr/sbin/nft",
  litestream: "/usr/local/bin/litestream",
  // ENTRYPOINT starts /usr/local/bin/node by absolute path, so execPath is that file.
  node: process.execPath,
});

/** Set root's PATH on an env object (default: this process). Returns the env. */
export function hardenPath(env = process.env) {
  env.PATH = SAFE_PATH;
  return env;
}
