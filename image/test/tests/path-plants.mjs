// Security review F-SEC-1 regression (scope §4 M1 row 8 intent; plan §4.13): uid 1000 plants an
// executable named after every binary ocsup or tini starts, in /home/node/.local/bin (first on the base
// image PATH, uid-1000 owned, kept by a snapshot). Root must never run a plant: tini, ocsup and every
// root spawn use absolute paths and PATH=/usr/sbin:/usr/bin:/sbin:/bin (lib/bins.mjs).
import { prepImage } from "../harness/box.mjs";

// Each name ocsup, tini or a spawn wrapper called by bare name before the fix, with its real path.
const REAL = {
  sh: "/bin/sh",
  tini: "/usr/bin/tini",
  node: "/usr/local/bin/node",
  hostname: "/usr/bin/hostname",
  sync: "/usr/bin/sync",
  nft: "/usr/sbin/nft",
  fallocate: "/usr/bin/fallocate",
  mount: "/usr/bin/mount",
  setpriv: "/usr/bin/setpriv",
  env: "/usr/bin/env",
  litestream: "/usr/local/bin/litestream",
};
const HITS = "/tmp/plant-hits";

// Plant: log "<uid> <name>" then exec the real binary, so a hit does not break the boot.
const PLANT = `set -e
d=/home/node/.local/bin; mkdir -p "$d"
: > ${HITS}; chmod 0666 ${HITS}
${Object.entries(REAL)
  .map(
    ([n, p]) =>
      `printf '#!/bin/sh\\necho "$(/usr/bin/id -u) ${n}" >> ${HITS}\\nexec ${p} "$@"\\n' > "$d/${n}"; chmod 0755 "$d/${n}"`,
  )
  .join("\n")}
PATH="$d:$PATH" hostname >/dev/null
echo planted $(ls "$d" | wc -l)`;

export default {
  name: "path-plants",
  source: "M1 security review F-SEC-1 (root RCE via PATH); scope §4 M1 row 8 intent; plan §4.13",
  rule: `uid 1000 plants /home/node/.local/bin/{${Object.keys(REAL).join(",")}} (each logs its uid, then execs the real binary); snapshot; boot to /startupz; planned stop (sync) and SIGTERM drain. No plant line with uid 0. PID 1 is /usr/bin/tini; ocsup runs /usr/local/bin/node; the image PATH has no /home/node dir.`,
  needs: ["m1", "ocsupctl"],
  timeoutMs: 600_000,
  async run(t) {
    const img = prepImage(t.image, "plants", PLANT);
    const b = t.box({ name: "a", gen: 1, image: img });
    await b.start();
    const up = await b.startupz();
    t.check("/startupz with plants in place", up !== null, up);
    const plants = b.sh("stat -c '%u %a %n' /home/node/.local/bin/* | sort").out.split("\n").filter(Boolean);
    t.measure("plants", plants);
    t.check(
      `${Object.keys(REAL).length} plants owned by uid 1000`,
      plants.length === Object.keys(REAL).length && plants.every((l) => l.startsWith("1000 755 ")),
      plants.length,
    );
    const pid1 = b.sh("tr '\\0' ' ' < /proc/1/cmdline").out.trim();
    t.measure("pid1", pid1);
    t.check(
      "PID 1 is /usr/bin/tini, ocsup by /usr/local/bin/node",
      /^\/usr\/bin\/tini -s -- \/usr\/local\/bin\/node /.test(pid1),
      pid1,
    );
    const imgPath = b.sh("echo $PATH").out.trim();
    t.measure("imagePath", imgPath);
    t.check("image PATH has no /home/node dir", !/\/home\/node/.test(imgPath), imgPath);
    // ocsup pid from its own "start" log line (a cmdline grep also hits tini and the exec shell).
    const opid = Number(b.ev("start")[0]?.pid);
    const live = b.sh(`readlink /proc/${opid}/exe`).out.trim();
    t.measure("ocsupExe", live);
    t.check("ocsup binary is /usr/local/bin/node", live === "/usr/local/bin/node", live);
    // Spawn paths after boot: planned stop (sync), then the SIGTERM drain (sync, Litestream final).
    t.measure("stop", b.ctl("stop", { timeoutMs: 120_000 }));
    await t.sleep(10_000);
    b.sigterm();
    const ex = await b.waitExit(240_000);
    t.measure("exit", ex);
    const hits = (b.cat(HITS)?.toString() || "").split("\n").filter(Boolean);
    t.measure("hits", hits);
    t.check(
      "control: the plant mechanism logs (uid-1000 hostname at fixture time)",
      hits.includes("1000 hostname"),
      hits.slice(0, 5),
    );
    const root = hits.filter((l) => l.startsWith("0 "));
    t.check("root never ran a plant", root.length === 0, root);
    const ran = b.events().map((e) => e.ev);
    t.check(
      "boot reached the spawn paths (netfilter, cgroups, litestream-start, gateway-start, drain sync)",
      ["netfilter", "litestream-start", "gateway-start"].every((e) => ran.includes(e)) &&
        b.events().some((e) => e.ev === "drain-step" && e.step === "sync"),
      ["netfilter", "litestream-start", "gateway-start", "drain-step"].filter((e) => ran.includes(e)),
    );
  },
};
