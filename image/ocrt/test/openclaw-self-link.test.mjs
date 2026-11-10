import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

// The bundled plugins import `openclaw/plugin-sdk/*`. Plain Node (the `openclaw infer web fetch` CLI) resolves it only
// through /app/node_modules/openclaw, so the image links it to /app (M8 live check 3).
describe("image/Dockerfile openclaw self link", () => {
  const df = fs.readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  it("creates the link in the tools stage", () => {
    assert.match(df, /ln -s \/app \/opt\/oc-nm\/openclaw/);
  });
  it("copies it into /app/node_modules in the runtime stage", () => {
    assert.match(df, /COPY --from=tools \/opt\/oc-nm\/ \/app\/node_modules\//);
  });
});
