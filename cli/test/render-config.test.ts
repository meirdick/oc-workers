// Item 10: `ochost config render` and the render step of `ochost deploy` against the fake /ops server.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FETCH_URL, RENDER_VERSION, renderOpenclawDoc } from "../src/config.ts";
import { renderStep } from "../src/deploy.ts";
import { mergeRender, renderVersionOf } from "../src/render-config.ts";
import { FakeOps, installDir, OWNER, run } from "./ops-fake.ts";

/** A config from before the loopback relay: owner keys, the old firecrawl address, no ochost key. */
const oldDoc = () => ({
  agents: { defaults: { model: { primary: "cfgw/@cf/a/b" }, userKey: 7 } },
  channels: { telegram: { enabled: true } },
  plugins: {
    entries: { firecrawl: { enabled: true, config: { webFetch: { baseUrl: "http://15.0.0.3", mine: 1 } } } },
  },
  tools: { web: { fetch: { provider: "firecrawl" } } },
});

describe("mergeRender (pure)", () => {
  it("render keys win, owner keys stay, new keys are added; the diff names top-level keys", () => {
    const { doc, diff } = mergeRender(oldDoc());
    expect(doc.plugins.entries.firecrawl.config.webFetch).toEqual({ baseUrl: FETCH_URL, mine: 1 });
    expect(doc.agents.defaults.userKey).toBe(7);
    expect(doc.agents.defaults.model.primary).toBe("cfgw/@cf/a/b");
    expect(doc.channels).toEqual({ telegram: { enabled: true } });
    expect(doc.ochost).toEqual({ renderVersion: RENDER_VERSION });
    expect(diff.added).toEqual(expect.arrayContaining(["browser", "memory", "ochost", "tts"]));
    expect(diff.changed).toEqual(expect.arrayContaining(["plugins", "agents"]));
    expect(diff.added).not.toContain("channels");
    expect(diff.changed).not.toContain("channels");
  });

  it("is idempotent, and a fresh init doc is already current", () => {
    const once = mergeRender(oldDoc()).doc;
    const twice = mergeRender(once);
    expect(twice.doc).toEqual(once);
    expect([...twice.diff.added, ...twice.diff.changed]).toEqual([]);
    expect(renderVersionOf(renderOpenclawDoc({ model: "@cf/a/b" }))).toBe(RENDER_VERSION);
    expect(renderVersionOf(oldDoc())).toBe(0);
  });
});

describe("config render and deploy", () => {
  let f: FakeOps;
  let dir: string;
  let versions: { ver: number; doc: Record<string, any> }[];
  let posts: any[];
  beforeEach(async () => {
    f = await new FakeOps().start();
    dir = installDir(f.url);
    versions = [{ ver: 3, doc: oldDoc() }];
    posts = [];
    f.routes.push((q) => {
      if (q.path === "/ops/config" && q.method === "GET")
        return { status: 200, body: { versions: versions.map((v) => ({ ver: v.ver, status: "good" })) } };
      const m = /^\/ops\/config\/(\d+)$/.exec(q.path);
      if (m)
        return {
          status: 200,
          body: { ver: Number(m[1]), doc: versions.find((v) => v.ver === Number(m[1]))?.doc },
        };
      if (q.path === "/ops/config" && q.method === "POST") {
        posts.push(q.body);
        const top = versions.at(-1) as (typeof versions)[number];
        if (JSON.stringify(top.doc) === JSON.stringify(q.body.doc))
          return { status: 200, body: { ok: true, ver: top.ver, same: true } };
        versions.push({ ver: top.ver + 1, doc: q.body.doc });
        return { status: 200, body: { ok: true, ver: top.ver + 1 } };
      }
      return undefined;
    });
  });
  afterEach(() => f.stop());

  it("config render posts the merged doc on top of the newest version and prints the diff", async () => {
    const r = await run("config", ["render", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(posts).toHaveLength(1);
    expect(f.reqs.find((q) => q.path === "/ops/render-check")?.body).toEqual({
      renderVersion: RENDER_VERSION,
    });
    expect(posts[0].baseVer).toBe(3);
    expect(posts[0].doc.ochost.renderVersion).toBe(RENDER_VERSION);
    expect(posts[0].doc.plugins.entries.firecrawl.config.webFetch.baseUrl).toBe(FETCH_URL);
    // docs/11 §8: storage location r2 on the install's own bucket, its own prefix, no credential in the doc
    expect(posts[0].doc.storage.locations.r2).toEqual({
      provider: "ochost-r2",
      settings: { endpoint: "http://127.0.0.1:18792", bucket: "oc-host-a1b2c3", prefix: "f/a1b2c3" },
      encryption: "none",
    });
    expect(posts[0].doc.plugins.entries["ochost-storage"]).toEqual({
      enabled: true,
      config: { location: "r2" },
    });
    expect(JSON.stringify(posts[0].doc)).not.toMatch(/accessKeyId|secretAccessKey|ocrt-g/);
    expect(r.out).toMatch(/config version 4 \(was 3\): added .*ochost.*; changed .*plugins/);
    expect(r.out).toMatch(/ochost restart applies it now/);
    const again = await run("config", ["render", "--dir", dir]);
    expect(again.out).toMatch(/already matches the render/);
    expect(posts).toHaveLength(2);
    expect(versions).toHaveLength(2);
  });

  it("--dry-run changes nothing", async () => {
    const r = await run("config", ["render", "--dry-run", "--dir", dir]);
    expect(r.code).toBe(0);
    expect(posts).toHaveLength(0);
    expect(r.out).toMatch(/render version 0: would change added .*ochost/);
  });

  it("deploy's render step merges an older document and says to restart; a current one is left alone", async () => {
    const warns: string[] = [];
    const ctx = {
      ui: { warn: (s: string) => warns.push(s) },
      fetch: (u: string, init?: RequestInit) => fetch(u, init),
    } as any;
    const r = await renderStep(ctx, f.url, OWNER, { bucket: "oc-host-a1b2c3", inst: "a1b2c3" });
    expect(r?.action).toBe("merged");
    expect(warns[0]).toMatch(
      new RegExp(`config render 0 -> ${RENDER_VERSION}: new config version 4 .*fix: ochost restart`),
    );
    expect(posts[0].doc.storage.locations.r2.settings.prefix).toBe("f/a1b2c3");
    expect(posts).toHaveLength(1);
    const r2 = await renderStep(ctx, f.url, OWNER);
    expect(r2?.action).toBe("none");
    expect(posts).toHaveLength(1);
    expect(warns).toHaveLength(1);
  });

  it("deploy's render step never throws: an unreachable or refusing Worker only warns", async () => {
    const warns: string[] = [];
    const down = {
      ui: { warn: (s: string) => warns.push(s) },
      fetch: async () => {
        throw new Error("down");
      },
    } as any;
    expect(await renderStep(down, "https://w", "t")).toBeNull();
    expect(warns[0]).toMatch(/config render skipped: down — fix: ochost config render/);
    f.routes.unshift((q) =>
      q.method === "POST" && q.path === "/ops/config" ? { status: 409, body: { ver: 9 } } : undefined,
    );
    const ctx = {
      ui: { warn: (s: string) => warns.push(s) },
      fetch: (u: string, i?: RequestInit) => fetch(u, i),
    } as any;
    expect(await renderStep(ctx, f.url, OWNER)).toBeNull();
    expect(warns[1]).toMatch(/config changed elsewhere \(base 3, current 9\)/);
  });
});
