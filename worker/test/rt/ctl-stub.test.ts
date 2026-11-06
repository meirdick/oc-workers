import { describe, expect, it } from "vitest";
import { freshStub } from "../../src/rt/ctl-stub";

describe("freshStub (M4 S5)", () => {
  it("re-creates the stub after a call throws; a good stub is kept", async () => {
    let made = 0;
    const make = () => {
      const n = ++made;
      return {
        ping: async (x: number) => {
          if (n === 1) throw new Error("broken stub");
          return x + n;
        },
      };
    };
    const s = freshStub(make);
    await expect(s.ping(1)).rejects.toThrow("broken stub");
    expect(await s.ping(1)).toBe(3);
    expect(await s.ping(2)).toBe(4);
    expect(made).toBe(2);
    expect((s as unknown as { then?: unknown }).then).toBeUndefined();
  });
});
