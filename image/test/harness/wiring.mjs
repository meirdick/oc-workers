// Which ocsup modules the image wires in. A lib/ module that exists but is not reachable from
// ocsup.mjs by static imports is not wired: tests that need it report `blocked`, not `fail`.

/** Node source run in the image: prints {"<path rel /opt/ocrt>": "<text>"} for ocsup.mjs, lib/, ocio/. */
export const DUMP_JS = `const fs=require("fs"),p=require("path");const o={};
for(const d of ["","lib","ocio"]){let n=[];try{n=fs.readdirSync(p.join("/opt/ocrt",d))}catch{}
for(const f of n)if(f.endsWith(".mjs"))o[p.join(d,f)]=fs.readFileSync(p.join("/opt/ocrt",d,f),"utf8")}
process.stdout.write(JSON.stringify(o))`;

const IMPORT_RE = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

const norm = (from, rel) => {
  const parts = from.split("/").slice(0, -1);
  for (const s of rel.split("/")) {
    if (s === "..") parts.pop();
    else if (s !== ".") parts.push(s);
  }
  return parts.join("/");
};

/** Files reachable from `entry` by relative static or dynamic imports. */
export function reachable(files, entry = "ocsup.mjs") {
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f) || files[f] === undefined) return;
    seen.add(f);
    for (const m of files[f].matchAll(IMPORT_RE)) walk(norm(f, m[1]));
  };
  walk(entry);
  return seen;
}

/** Quoted string literals in a file (cheap token scan for op and fault names). */
const hasLit = (text, s) => text !== undefined && (text.includes(`"${s}"`) || text.includes(`'${s}'`));

/** Feature flags from the image's ocrt sources. */
export function wiringFeatures(files) {
  const r = reachable(files);
  const w = (m) => r.has(`lib/${m}.mjs`);
  const main = files["lib/main.mjs"] || "";
  return {
    wired: [...r].sort(),
    credsync: w("credsync"),
    shadow: w("shadow") && hasLit(main, "shadow-backup"),
    archive: w("archive") && hasLit(main, "archive"),
    diskwatch: w("diskwatch"),
    guardBoot: w("guard-boot"),
    configRender: w("config"),
    marker: w("marker"),
    memwatch: w("memwatch"),
    heapFault: hasLit(files["lib/faults.mjs"], "heap"),
  };
}
