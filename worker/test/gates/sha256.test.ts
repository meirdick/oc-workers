// Incremental SHA-256 with a JSON state (spec §24 open item "Streaming SHA-256 state for archive parts":
// M2 unit test with 3 × 16 MiB parts).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type ShaState, shaDigest, shaInit, shaUpdate } from "../../src/gates/sha256";

const node = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("incremental sha256", () => {
  it("matches node:crypto for lengths 0..200 and odd split points", () => {
    for (let n = 0; n <= 200; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
      const cut = Math.floor(n / 3);
      let s = shaUpdate(shaInit(), b.subarray(0, cut));
      s = JSON.parse(JSON.stringify(s)) as ShaState;
      s = shaUpdate(s, b.subarray(cut));
      expect(shaDigest(s)).toBe(node(b));
    }
  });

  it("3 × 16 MiB parts with the state stored as JSON between parts", () => {
    const part = 16 * 1024 * 1024;
    const h = createHash("sha256");
    let s = shaInit();
    for (let p = 0; p < 3; p++) {
      const b = new Uint8Array(part);
      for (let i = 0; i < b.length; i += 4096) b[i] = (i / 4096 + p) & 255;
      h.update(b);
      s = JSON.parse(JSON.stringify(shaUpdate(s, b))) as ShaState;
    }
    expect(s.n).toBe(3 * part);
    expect(shaDigest(s)).toBe(h.digest("hex"));
  });
});
