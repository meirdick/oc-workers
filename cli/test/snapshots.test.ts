// ochost status `snapshots` line and warning; ochost snapshot prune (Control DO marks first, then tags go).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotTag } from "../src/snapshot.ts";
import { FakeOps, fakeRunner, installDir, run, statusBody } from "./ops-fake.ts";

let ops: FakeOps;
let dir: string;
beforeEach(async () => {
  ops = await new FakeOps().start();
  dir = installDir(ops.url);
});
afterEach(() => ops.stop());

const summary = (tags: number) => ({
  chainBase: "s1",
  chainLength: tags / 2,
  chainAgeMs: 26 * 3_600_000,
  indexed: tags / 2,
  tags,
  bytes: 165_000_000,
  rebase: { due: true, why: "chain root is 26 h old", pending: null },
  prune: { ready: false, why: "waiting", count: 0, bytes: 0 },
  warn: tags > 100 ? `about ${tags} registry tags (> 100); run ochost snapshot prune` : null,
});

describe("status snapshots", () => {
  it("shows chain, tags, bytes and rebase; warns above 100 tags", async () => {
    ops.status = statusBody({ snapshots: summary(178) });
    const r = await run("status", ["--dir", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      /snapshots\s+chain 89 \(root .*old\) · about 178 registry tags, 165 MB \(estimate\) · rebase due/,
    );
    expect(r.err).toMatch(/about 178 registry tags \(> 100\); run ochost snapshot prune/);
  });

  it("no warning at 100 tags or fewer; no line on an older Worker", async () => {
    ops.status = statusBody({ snapshots: summary(20) });
    const a = await run("status", ["--dir", dir]);
    expect(a.err).not.toMatch(/registry tags/);
    ops.status = statusBody();
    const b = await run("status", ["--dir", dir]);
    expect(b.out).not.toMatch(/^snapshots/m);
  });
});

describe("snapshot prune", () => {
  const ids = ["o1", "o2"];
  const tags = ids.map(snapshotTag);
  const runner = () =>
    fakeRunner((c) =>
      c.args.includes("list")
        ? {
            stdout: JSON.stringify([
              {
                name: "oc-m5-test-runtime-oc",
                tags: ["wrangler-abc", ...tags, snapshotTag("n1"), "rootfs-set-xyz"],
              },
              { name: "oc-demo-runtime-oc", tags: [snapshotTag("o1")] },
            ]),
          }
        : undefined,
    );

  it("tag is sha256 of the snapshot id (spike T2-T3 sample)", () => {
    expect(snapshotTag("ffcea785-3364-4ec3-bdd5-b130fe5d4a0c")).toMatch(
      /^rootfs-snapshot-e3ea3f3bdb330dde33c2485a/,
    );
  });

  it("not ready: deletes nothing", async () => {
    ops.routes.push((r) =>
      r.path === "/ops/snapshots/prune"
        ? { status: 200, body: { ready: false, why: "waiting for one wake", ids: [] } }
        : undefined,
    );
    const fr = runner();
    const r = await run("snapshot", ["prune", "--dir", dir, "--yes"], { run: fr.run });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/nothing to prune: waiting for one wake/);
    expect(fr.calls.some((c) => c.args.includes("delete"))).toBe(false);
  });

  it("marks in the Control DO first, then deletes only the allowed tags of this install", async () => {
    const order: string[] = [];
    ops.routes.push((r) => {
      if (r.path !== "/ops/snapshots/prune") return undefined;
      if (r.method === "GET") return { status: 200, body: { ready: true, why: "2", ids } };
      order.push("mark");
      return { status: 200, body: { pruned: ["o1"], refused: ["o2"] } };
    });
    const fr = runner();
    const wrapped = async (cmd: string, args: string[], o?: { input?: string }) => {
      if (args.includes("delete")) order.push("delete");
      return fr.run(cmd, args, o as never);
    };
    const r = await run("snapshot", ["prune", "--dir", dir, "--yes"], { run: wrapped as never });
    expect(r.code).toBe(0);
    const dels = fr.calls.filter((c) => c.args.includes("delete")).map((c) => c.args.slice(-1)[0]);
    expect(dels).toEqual([`oc-m5-test-runtime-oc:${snapshotTag("o1")}`]);
    expect(order).toEqual(["mark", "delete"]);
    expect(r.out).toMatch(/deleted 1 tag\(s\); 1 refused/);
  });

  it("--dry-run lists the tags and marks nothing", async () => {
    ops.routes.push((r) =>
      r.path === "/ops/snapshots/prune" && r.method === "GET"
        ? { status: 200, body: { ready: true, ids } }
        : undefined,
    );
    const fr = runner();
    const r = await run("snapshot", ["prune", "--dir", dir, "--dry-run"], { run: fr.run });
    expect(r.out).toMatch(/plan: 2 snapshot\(s\) of old chains, 2 tag\(s\) in the registry/);
    expect(ops.calls("POST", "/ops/snapshots/prune")).toHaveLength(0);
  });
});
