import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixRootOwners, ROOT_DIRS } from "../lib/rootfs.mjs";

/** Fake fs: path -> {uid, gid, mode, dir}. Records chown/chmod calls. */
function fakeFs(tree, { failChown = false } = {}) {
  const calls = [];
  return {
    calls,
    tree,
    lstatSync(p) {
      const e = tree[p];
      if (!e) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return {
        uid: e.uid,
        gid: e.gid,
        mode: (e.dir === false ? 0o100000 : 0o40000) | e.mode,
        isDirectory: () => e.dir !== false,
      };
    },
    chownSync(p, u, g) {
      if (failChown) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      calls.push(["chown", p, u, g]);
      Object.assign(tree[p], { uid: u, gid: g });
    },
    chmodSync(p, m) {
      calls.push(["chmod", p, m]);
      tree[p].mode = m;
    },
  };
}

describe("rootfs owners (demo cutover 2026-11-05: '/' owned by uid 2346)", () => {
  it("gives a foreign-owned / back to root and records the old owner", () => {
    const f = fakeFs({
      "/": { uid: 2346, gid: 2346, mode: 0o755 },
      "/tmp": { uid: 0, gid: 0, mode: 0o1777 },
    });
    const r = fixRootOwners({ dirs: ["/", "/tmp"], fsx: f });
    assert.deepEqual(r.fixed, [{ path: "/", uid: 2346, gid: 2346, mode: "755", chown: "0:0" }]);
    assert.deepEqual(f.calls, [["chown", "/", 0, 0]]);
  });

  it("drops group/world write without sticky; keeps a sticky 1777 /tmp", () => {
    const f = fakeFs({ "/": { uid: 0, gid: 0, mode: 0o775 }, "/tmp": { uid: 0, gid: 0, mode: 0o1777 } });
    const r = fixRootOwners({ dirs: ["/", "/tmp"], fsx: f });
    assert.deepEqual(r.fixed, [{ path: "/", uid: 0, gid: 0, mode: "775", chmod: "755" }]);
    assert.equal(f.tree["/tmp"].mode, 0o1777);
  });

  it("root-owned 0755 dirs and missing dirs: no change", () => {
    const f = fakeFs({ "/": { uid: 0, gid: 0, mode: 0o755 } });
    assert.deepEqual(fixRootOwners({ dirs: ["/", "/nope"], fsx: f }).fixed, []);
    assert.deepEqual(f.calls, []);
  });

  it("a failed chown is reported, not thrown", () => {
    const f = fakeFs({ "/": { uid: 2346, gid: 2346, mode: 0o755 } }, { failChown: true });
    const r = fixRootOwners({ dirs: ["/"], fsx: f });
    assert.equal(r.fixed[0].err, "EPERM");
  });

  it("covers / and the ancestors of state, temp and stage dirs; never /home/node", () => {
    for (const d of ["/", "/tmp", "/home", "/var", "/var/lib"]) assert.ok(ROOT_DIRS.includes(d), d);
    assert.ok(!ROOT_DIRS.includes("/home/node"));
  });
});
