// core/contract.ts is the TypeScript face of image/ocrt/lib/contract.mjs. This test keeps the route lists equal:
// contract.ts ROUTES = contract.mjs ROUTES + the M2 additions (spec §23), and the doc table of
// docs/07-gate-contract.md §2 lists the same contract.mjs routes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as C from "../../../image/ocrt/lib/contract.mjs";
import { CONTRACT_ROUTES, exitCode, M2_ROUTES, ROUTES, routeFor } from "../../src/core/contract";

const key = (r: { m: string; path: string }) => `${r.m} ${r.path}`;
const DOC = fileURLToPath(new URL("../../../docs/07-gate-contract.md", import.meta.url).href);

/** Routes from the doc table rows "| `METHOD /v1/...` |". Doc writes params as <path>, code as :path. */
function docRoutes(): string[] {
  const out: string[] = [];
  for (const line of readFileSync(DOC, "utf8").split("\n")) {
    const m = /^\| `(GET|PUT|POST|DELETE) (\/v1\/[^`?]+)(\?[^`]*)?`/.exec(line);
    if (m) out.push(`${m[1]} ${(m[2] as string).replace(/<[^>]+>/g, ":p")}`);
  }
  return out;
}

describe("contract.ts mirrors contract.mjs", () => {
  it("§23 heartbeat fields and plan fields validate", () => {
    const hb = {
      inst: "t1",
      gen: 3,
      seq: 1,
      phase: "running",
      draining: false,
      lastActivityAt: 1_793_500_000_000,
      telegramSecretVersion: 2,
      channels: [{ channel: "telegram", account: "default", transport: "webhook" }],
      eventJobs: [{ id: "j1", kind: "event" }],
    };
    expect(C.validate(C.HeartbeatReq, hb)).toEqual([]);
    expect(C.validate(C.HeartbeatReq, { ...hb, channels: [{ account: "x" }] }).length).toBeGreaterThan(0);
    expect(C.validate(C.WakeAllowReq, { inst: "t1", gen: 3, userIds: ["42"], groupChatIds: [] })).toEqual([]);
  });

  it("ROUTES = contract.mjs ROUTES + M2_ROUTES, in order", () => {
    const mjs = (C.ROUTES as unknown as { m: string; path: string }[]).map(key);
    expect(CONTRACT_ROUTES.map(key)).toEqual(mjs);
    expect(ROUTES.map(key)).toEqual([...mjs, ...M2_ROUTES.map(key)]);
    expect(M2_ROUTES.map(key)).toEqual([]); // §23 additions live in contract.mjs now
    expect(mjs).toContain("PUT /v1/wake-allow");
    for (const r of M2_ROUTES) expect(mjs).not.toContain(key(r)); // delete from M2_ROUTES once the .mjs has it
  });

  it("docs/07 §2 table lists every contract.mjs route", () => {
    const doc = docRoutes().sort();
    const code = (C.ROUTES as unknown as { m: string; path: string }[])
      .map((r) => `${r.m} ${r.path.replace(/:[a-z]+/g, ":p")}`)
      .sort();
    expect(doc).toEqual(code);
  });

  it("routeFor: exact routes win over param routes; M2 route found", () => {
    expect(routeFor("GET", "/v1/creds/manifest")?.path).toBe("/v1/creds/manifest");
    expect(routeFor("GET", "/v1/creds/credentials/wa/creds.json")?.path).toBe("/v1/creds/:path");
    expect(routeFor("PUT", "/v1/wake-allow")?.path).toBe("/v1/wake-allow");
    expect(routeFor("GET", "/v1/nope")).toBeNull();
    expect(routeFor("POST", "/v1/hello")).toEqual(C.routeFor("POST", "/v1/hello"));
  });

  it("exit reasons: C24 restore-blocked:rewound → 75 in contract.mjs; others from contract.mjs", () => {
    expect(exitCode("restore-blocked:rewound")).toBe(75);
    expect(C.exitCodeFor("restore-blocked:rewound")).toBe(75);
    expect(exitCode("stale")).toBe(77);
    expect(exitCode("netfilter-failed")).toBe(70);
  });
});
