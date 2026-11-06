import { describe, expect, it } from "vitest";
import { originOk } from "../../src/ingress/headers";

const U = "https://oc.example.workers.dev/_ochost/login";
const post = (h: Record<string, string>) => new Request(U, { method: "POST", headers: h, body: "token=x" });

describe("originOk with a null Origin", () => {
  it("accepts Origin: null when Sec-Fetch-Site is same-origin (Firefox, no-referrer)", () => {
    expect(originOk(post({ origin: "null", "sec-fetch-site": "same-origin" }))).toBe(true);
  });
  it("accepts a missing Origin when Sec-Fetch-Site is same-origin", () => {
    expect(originOk(post({ "sec-fetch-site": "same-origin" }))).toBe(true);
  });
  it("refuses Origin: null from a cross-site context", () => {
    expect(originOk(post({ origin: "null", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(originOk(post({ origin: "null" }))).toBe(false);
  });
  it("still refuses a foreign Origin", () => {
    expect(originOk(post({ origin: "https://evil.example", "sec-fetch-site": "same-origin" }))).toBe(false);
  });
});
