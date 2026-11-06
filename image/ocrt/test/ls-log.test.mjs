import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyLine, lineSplitter, parseLogfmt } from "../lib/ls-log.mjs";

// Lines as logged by Litestream 0.5.17 (docs/06-m0-amendments.md §1.4 and db.go messages).
const F1 =
  'time=2026-10-31T09:37:00.662Z level=ERROR msg="monitor error" system=store db=openclaw.sqlite replica=s3 error="open ltx file /data/s/.openclaw.sqlite-litestream/ltx/0/0000000000000001-0000000000000001.ltx: open /data/s/.openclaw.sqlite-litestream/ltx/0/0000000000000001-0000000000000001.ltx: no such file or directory" path=/data';

describe("ls-log", () => {
  it("parses slog text", () => {
    const f = parseLogfmt(F1);
    assert.equal(f.level, "ERROR");
    assert.equal(f.msg, "monitor error");
    assert.equal(f.db, "openclaw.sqlite");
    assert.match(f.error, /no such file/);
  });
  it("F1 line is ltx-missing (F1.4)", () => {
    assert.equal(classifyLine(F1).cls, "ltx-missing");
  });
  it("shutdown sync failed is unclean (F1.6)", () => {
    assert.equal(
      classifyLine('time=x level=WARN msg="shutdown sync failed, retrying" db=a.sqlite error="x"').cls,
      "shutdown-sync-failed",
    );
    assert.equal(
      classifyLine('time=x level=ERROR msg="shutdown sync failed after timeout" db=a.sqlite').cls,
      "shutdown-sync-failed",
    );
  });
  it("ENOSPC is disk-full before any replica class (Z0.4)", () => {
    assert.equal(
      classifyLine('level=ERROR msg="sync error" db=a error="write x: no space left on device"').cls,
      "disk-full",
    );
    assert.equal(
      classifyLine(
        'level=ERROR msg="disk full while staging ltx file, replication paused until space is freed"',
      ).cls,
      "disk-full",
    );
    assert.equal(
      classifyLine('level=ERROR msg="monitor error" error="open ltx file /x: no space left on device"').cls,
      "disk-full",
    );
  });
  it("409 stale from the gate", () => {
    assert.equal(
      classifyLine('level=ERROR msg="sync error" error="StatusCode: 409, stale"').cls,
      "gate-stale",
    );
  });
  it("info lines need no action", () => {
    assert.equal(classifyLine('level=INFO msg="snapshot complete" txid=0000000000000001 size=4096'), null);
  });
  it("splits lines across chunks", () => {
    const got = [];
    const f = lineSplitter((l) => got.push(l));
    f("a\nb");
    f("c\n\nd\n");
    assert.deepEqual(got, ["a", "bc", "d"]);
  });
});
