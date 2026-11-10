// `ochost import` into the sandbox workspace (docs/12 §5). With the sandbox on, OpenClaw seeds the remote workspace
// from the gateway copy once and never again, so an import that only reaches <state>/workspace is invisible to
// sandboxed chats. This merges the same bundle into every seeded remote workspace with the rules of ocio import
// (add missing, keep the sandbox's own files, replace only `overwrite`, move `remove` to the backup). A sandbox
// that was never seeded needs nothing: its first use seeds from the gateway copy, which has the import.
// The script runs in the sandbox (python3 is in image/sandbox) with the bundle on stdin; no network there.

/** Python merge script. Arguments come as one JSON argv item, never through the shell. */
export const MERGE_PY = String.raw`
import sys, os, io, json, tarfile, hashlib, glob
a = json.loads(sys.argv[1])
rid, over, rem = a["id"], set(a.get("overwrite", [])), a.get("remove", [])
base = a.get("root", "/workspace")
data = sys.stdin.buffer.read()
files = {}
skipped = 0
with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
    for m in tf.getmembers():
        n = os.path.normpath(m.name)
        if n in (".", "") or n.startswith("/") or n.split("/")[0] == ".." or ".." in n.split("/"):
            continue
        if not m.isfile():
            if not m.isdir(): skipped += 1
            continue
        if n.startswith(".ochost-import/"):
            skipped += 1
            continue
        files[n] = tf.extractfile(m).read()
seen = set()
for p in glob.glob(base + "/**/AGENTS.md", recursive=True) + glob.glob(base + "/**/SOUL.md", recursive=True):
    d = os.path.dirname(p)
    if "/.ochost-import/" in d + "/" or d.count("/") - base.count("/") > 4: continue
    seen.add(d)
# Only the shallowest: a seeded workspace may hold projects with their own AGENTS.md.
roots = []
for d in sorted(seen, key=len):
    if not any((d + "/").startswith(r + "/") for r in roots): roots.append(d)
def safe(root, rel):
    cur = root
    for part in rel.split("/")[:-1]:
        cur = os.path.join(cur, part)
        if os.path.islink(cur) or (os.path.exists(cur) and not os.path.isdir(cur)): return False
    return not os.path.islink(os.path.join(root, rel))
def write(p, b):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    t = p + ".ochost-tmp"
    with open(t, "wb") as f: f.write(b)
    os.replace(t, p)
out = []
for root in roots:
    r = {"root": root, "added": 0, "same": 0, "replaced": 0, "kept": 0, "removed": 0, "skipped": skipped}
    bk = os.path.join(root, ".ochost-import", rid, "backup")
    lower = {}
    for dp, dn, fn in os.walk(root):
        for f in fn:
            rp = os.path.relpath(os.path.join(dp, f), root)
            lower[rp.lower()] = rp
    for rel, b in sorted(files.items()):
        if not safe(root, rel):
            r["skipped"] += 1
            continue
        p = os.path.join(root, rel)
        if os.path.exists(p):
            if not os.path.isfile(p):
                r["skipped"] += 1
                continue
            cur = open(p, "rb").read()
            if hashlib.sha256(cur).digest() == hashlib.sha256(b).digest():
                r["same"] += 1
            elif rel in over and not glob.glob(os.path.join(root, ".ochost-import", "*", "backup", glob.escape(rel))):
                write(os.path.join(bk, rel), cur)
                write(p, b)
                r["replaced"] += 1
            else:
                r["kept"] += 1
        elif lower.get(rel.lower(), rel) != rel:
            r["skipped"] += 1  # differs only in case from a file there: openclaw backup refuses that
        else:
            write(p, b)
            lower[rel.lower()] = rel
            r["added"] += 1
    for rel in rem:
        p = os.path.join(root, rel)
        if safe(root, rel) and os.path.isfile(p):
            write(os.path.join(bk, rel), open(p, "rb").read())
            os.remove(p)
            r["removed"] += 1
    out.append(r)
print(json.dumps({"ok": True, "targets": out}))
`;

/** sh -c command for SandboxCore.exec: the script and its JSON argument, each single-quoted. */
export function mergeCommand(a: {
  id: string;
  overwrite: string[];
  remove: string[];
  root?: string;
}): string {
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  return `python3 -c ${q(MERGE_PY)} ${q(JSON.stringify(a))}`;
}
