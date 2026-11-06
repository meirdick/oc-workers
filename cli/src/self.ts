// How to call this CLI again in a printed hint ("Next: …"). DX-1 U1/U8: init printed `ochost …` while ochost was
// not on PATH. `ochost` when it is on PATH, else `node <abs path of bin/ochost.js>`.
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const q = (s: string) => (/[\s"'$`\\]/.test(s) ? JSON.stringify(s) : s);

export function onPath(name: string, path = process.env.PATH ?? ""): boolean {
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((d) => existsSync(join(d, name)));
}

export function selfCommand(
  o: { path?: string; argv1?: string } = { path: process.env.PATH, argv1: process.argv[1] },
): string {
  if (onPath("ochost", o.path ?? "")) return "ochost";
  if (o.argv1 && /ochost(\.m?js)?$/.test(o.argv1)) return `node ${q(resolve(o.argv1))}`;
  return "ochost";
}

/** ` --dir <dir>` when the install is not the current directory, else "". */
export function dirArg(dir: string, cwd = process.cwd()): string {
  return resolve(dir) === resolve(cwd) ? "" : ` --dir ${q(resolve(dir))}`;
}

/** The command init prints last. Adds --dir when the install is not the current directory. */
export function nextCommand(dir: string, cwd = process.cwd(), self = selfCommand()): string {
  return `${self} channels add telegram${dirArg(dir, cwd)}`;
}
