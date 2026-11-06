import { describe, expect, it } from "vitest";
import { world } from "./world";

describe("smoke", () => {
  it("boots to running", async () => {
    const w = world();
    const st = await w.boot();
    expect(st).toBe("running");
    expect(w.c.startCount).toBe(1);
    expect(w.ctl.started).toEqual([1]);
  });
});
