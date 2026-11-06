// Plan §4.1 and amend §3 (nft copied): image facts M1 checks without a boot.
import { dk } from "../harness/docker.mjs";

export default {
  name: "image-contents",
  source: "plan §4.1 (labels, no root-owned SQLite, runtime stage COPY only); amend §3 row 'T2 item 8' (nft)",
  rule: "nft runs (version); litestream 0.5.17; tini 0.19; no *.sqlite* owned by root on the rootfs; labels oc-host.openclaw.version, oc-host.base.digest, oc-host.ocsup.sha present; /opt/ocrt/ocio/ present.",
  timeoutMs: 300_000,
  async run(t) {
    const sh = (c) => dk(["run", "--rm", "--entrypoint", "sh", t.image, "-c", c]);
    const nft = sh("nft --version 2>&1");
    t.check("nft runs", nft.code === 0 && /nftables/.test(nft.out), nft.out || nft.err);
    t.check("litestream 0.5.17", sh("litestream version").out.trim() === "0.5.17");
    t.check("tini present", sh("tini --version").out.includes("0.19"));
    const rootDb = sh(
      "find / -xdev \\( -name '*.sqlite' -o -name '*.sqlite-wal' -o -name '*.db' \\) -user root 2>/dev/null | grep -v '^/proc' | head -20",
    ).out;
    t.measure("rootOwnedSqlite", rootDb.split("\n").filter(Boolean));
    t.check("no root-owned *.sqlite on the rootfs", !/\.sqlite/.test(rootDb), rootDb);
    const labels = JSON.parse(dk(["image", "inspect", "-f", "{{json .Config.Labels}}", t.image]).out || "{}");
    t.measure("labels", labels);
    t.check(
      "labels present",
      !!labels["oc-host.openclaw.version"] &&
        !!labels["oc-host.base.digest"] &&
        !!labels["oc-host.ocsup.sha"],
    );
    t.check("/opt/ocrt/ocio present", sh("ls /opt/ocrt/ocio | head -3").out !== "");
    const size = Number(dk(["image", "inspect", "-f", "{{.Size}}", t.image]).out);
    t.measure("imageBytes", size);
  },
};
