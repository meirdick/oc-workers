// Scope §4 M1 last row: two pushes of the same build give equal digests (no double build needed).
// Local stand-in for registry.cloudflare.com: registry:2 per harness run.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dk } from "../harness/docker.mjs";
import { N, PFX } from "../harness/env.mjs";

export default {
  name: "reproducible-build-digests",
  source: "scope §4 M1 'Two pushes of the same build give equal digests'",
  rule: "Push the built image twice (two tags, one repo) to a local registry: equal manifest digests. Also: two docker builds of one frozen tree (git archive HEAD of image/) give the same image id. --provenance=false: BuildKit's provenance attestation carries a per-build ref, so with it the index digest differs while config and layers are equal (measured 2026-10-31).",
  timeoutMs: 1_200_000,
  async run(t) {
    if (
      dk(["image", "inspect", "registry:2"]).code !== 0 &&
      dk(["pull", "registry:2"], { timeoutMs: 300_000 }).code !== 0
    )
      return t.block("registry:2 not pullable");
    // Per-network run: own registry name and host port (15500 + N).
    const reg = `${PFX}-registry`;
    const port = 15500 + N;
    dk(["rm", "-f", reg]);
    const r = dk(["run", "-d", "--name", reg, "-p", `127.0.0.1:${port}:5000`, "registry:2"]);
    t.track({ name: reg, text: () => "", rm: () => dk(["rm", "-f", reg]) });
    if (!t.check("registry up", r.code === 0, r.err.slice(-200) || undefined)) return;
    await t.sleep(2000);
    const push = (tag) => {
      const dst = `127.0.0.1:${port}/oc-m1:${tag}`;
      dk(["tag", t.image, dst]);
      const p = dk(["push", dst], { timeoutMs: 900_000 });
      const m = /digest: (sha256:[0-9a-f]{64})/.exec(p.out);
      return { tag, digest: m?.[1] || null, code: p.code, err: p.err.slice(-200) };
    };
    const p1 = push("a");
    const p2 = push("b");
    t.measure("push", [p1, p2]);
    t.check("both pushes give a digest", !!p1.digest && !!p2.digest, [p1.digest, p2.digest]);
    t.check("digests equal", p1.digest === p2.digest, [p1.digest, p2.digest]);
    // Two builds of one tree, back to back (other builders edit the tree, so not the runner's image).
    const sha = dk(["image", "inspect", "-f", '{{index .Config.Labels "oc-host.ocsup.sha"}}', t.image]).out;
    // Freeze the tree: other builders edit image/ocrt while this runs, which changes the id.
    const imageDir = new URL("../..", import.meta.url).pathname;
    const ctx = fs.mkdtempSync(path.join(os.tmpdir(), `${PFX}-rb-`));
    const ar = spawnSync("sh", ["-c", `git -C "${imageDir}" archive HEAD . | tar -x -C "${ctx}"`], {
      encoding: "utf8",
    });
    if (!t.check("tree snapshot (git archive HEAD)", ar.status === 0, ar.stderr.slice(-200) || undefined))
      return;
    t.measure(
      "snapshotRev",
      spawnSync("git", ["-C", imageDir, "rev-parse", "--short=12", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim(),
    );
    const bld = (tag) =>
      dk(["build", "-q", "--provenance=false", "-t", tag, "--build-arg", `OCSUP_SHA=${sha}`, ctx], {
        timeoutMs: 1_200_000,
      }).out.trim();
    const id1 = bld(`${t.image}-rb1`);
    const id2 = bld(`${t.image}-rb2`);
    t.measure("imageIds", { first: id1, second: id2 });
    t.check("two builds of one tree give the same image id", !!id1 && id1 === id2, { id1, id2 });
    dk(["rmi", `${t.image}-rb1`, `${t.image}-rb2`]);
    fs.rmSync(ctx, { recursive: true, force: true });
  },
};
