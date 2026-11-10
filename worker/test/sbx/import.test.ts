// sbx/import.ts: the merge script that `ochost import` runs in the sandbox, run here with the local python3 against
// a temp root that looks like the sandbox's /workspace (one seeded workspace, a project with its own AGENTS.md).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeCommand } from "../../src/sbx/import";

const py = spawnSync("python3", ["--version"]).status === 0;

function tgz(files: Record<string, string>): Buffer {
  const d = mkdtempSync(join(tmpdir(), "sbx-src-"));
  for (const [rel, v] of Object.entries(files)) {
    mkdirSync(join(d, rel, ".."), { recursive: true });
    writeFileSync(join(d, rel), v);
  }
  symlinkSync("/etc/passwd", join(d, "evil"));
  return spawnSync("tar", ["-czf", "-", "-C", d, "."]).stdout;
}

describe.skipIf(!py)("sandbox merge script", () => {
  it("merges into the seeded workspace only; keeps sandbox edits; replaces listed files with a backup; idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "sbx-root-"));
    const ws = join(root, "openclaw-ssh-workspace-ab12", "workspace");
    mkdirSync(join(ws, "projects", "p1"), { recursive: true });
    writeFileSync(join(ws, "AGENTS.md"), "seeded default");
    writeFileSync(join(ws, "notes.md"), "sandbox edit");
    writeFileSync(join(ws, "BOOTSTRAP.md"), "ritual");
    writeFileSync(join(ws, "projects", "p1", "AGENTS.md"), "project agents");
    const b = tgz({ "AGENTS.md": "old agents", "notes.md": "old notes", "memory/a.md": "m" });
    const run = () =>
      spawnSync(
        "/bin/sh",
        ["-c", mergeCommand({ id: "t1", overwrite: ["AGENTS.md"], remove: ["BOOTSTRAP.md"], root })],
        {
          input: b,
        },
      );
    const r = run();
    expect(r.status, String(r.stderr)).toBe(0);
    const j = JSON.parse(String(r.stdout));
    expect(j.targets).toEqual([
      { root: ws, added: 1, same: 0, replaced: 1, kept: 1, removed: 1, skipped: 1 },
    ]);
    expect(readFileSync(join(ws, "AGENTS.md"), "utf8")).toBe("old agents");
    expect(readFileSync(join(ws, "notes.md"), "utf8")).toBe("sandbox edit");
    expect(readFileSync(join(ws, ".ochost-import/t1/backup/AGENTS.md"), "utf8")).toBe("seeded default");
    expect(existsSync(join(ws, "BOOTSTRAP.md"))).toBe(false);
    expect(existsSync(join(ws, "projects", "p1", "memory"))).toBe(false);
    expect(existsSync(join(ws, "evil"))).toBe(false);
    const again = JSON.parse(String(run().stdout));
    expect(again.targets[0]).toMatchObject({ added: 0, same: 2, replaced: 0, kept: 1, removed: 0 });
    writeFileSync(join(ws, "AGENTS.md"), "edited later");
    const third = JSON.parse(String(run().stdout));
    expect(third.targets[0]).toMatchObject({ replaced: 0, kept: 2 });
    expect(readFileSync(join(ws, "AGENTS.md"), "utf8")).toBe("edited later");
  });

  it("a file that differs only in case from one there is skipped", () => {
    const root = mkdtempSync(join(tmpdir(), "sbx-case-"));
    const ws = join(root, "w1", "workspace");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "AGENTS.md"), "a");
    writeFileSync(join(ws, "budget.csv"), "x");
    const r = spawnSync("/bin/sh", ["-c", mergeCommand({ id: "t1", overwrite: [], remove: [], root })], {
      input: tgz({ "BUDGET.csv": "y" }),
    });
    expect(JSON.parse(String(r.stdout)).targets[0]).toMatchObject({ added: 0, skipped: 2 }); // + the symlink
    expect(existsSync(join(ws, "BUDGET.csv"))).toBe(false);
  });

  it("no seeded workspace: nothing to do", () => {
    const root = mkdtempSync(join(tmpdir(), "sbx-empty-"));
    const r = spawnSync("/bin/sh", ["-c", mergeCommand({ id: "t1", overwrite: [], remove: [], root })], {
      input: tgz({ "a.md": "a" }),
    });
    expect(JSON.parse(String(r.stdout))).toEqual({ ok: true, targets: [] });
  });
});
