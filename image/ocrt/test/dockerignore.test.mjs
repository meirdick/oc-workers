import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

// The build context excludes everything but a list. The sandbox backend plugin must be on it, or the image has
// no /opt/ocrt/plugins and the gateway fails with `Sandbox backend "ochost" is not registered` (M7 live check).
describe("image/.dockerignore", () => {
  const lines = fs
    .readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.trim());
  it("lets the ochost-sandbox plugin into the build context", () => {
    assert.ok(lines.includes("!ocrt/plugins/"));
    assert.ok(fs.existsSync(new URL("../plugins/ochost-sandbox/openclaw.plugin.json", import.meta.url)));
  });
  it("lets the ochost-storage plugin into the build context (Dockerfile COPY plugins/ochost-storage/)", () => {
    assert.ok(lines.includes("!plugins/ochost-storage/"));
    assert.ok(fs.existsSync(new URL("../../plugins/ochost-storage/openclaw.plugin.json", import.meta.url)));
  });
});
