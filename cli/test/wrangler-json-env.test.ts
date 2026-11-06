import { describe, expect, it } from "vitest";
import { jsonFormatEnv } from "../src/wrangler.ts";

// M8 live: `wrangler containers images list --json` printed nothing under WRANGLER_LOG=error, so `ochost destroy`
// planned 0 image tags and left them in the registry.
describe("jsonFormatEnv", () => {
  it("raises the log level for --format json", () => {
    expect(jsonFormatEnv(["x", "--format", "json"])).toEqual({ WRANGLER_LOG: "log" });
  });
  it("raises the log level for --json", () => {
    expect(jsonFormatEnv(["containers", "images", "list", "--json", "--filter", "p-"])).toEqual({
      WRANGLER_LOG: "log",
    });
  });
  it("leaves other calls quiet", () => {
    expect(jsonFormatEnv(["secret", "put", "A"])).toEqual({});
  });
});
