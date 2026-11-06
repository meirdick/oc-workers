// docs/11 §8: file storage through the ReplicaGate files key space. The ochost-storage plugin is a bundled extension
// of the image. Offline (--network none, uid 1000): ocsup's real loopback forwarder (lib/cap-proxy.mjs, port 18792)
// in front of a mock gate that checks SigV4 and the real contract rule (filesAccess); ocsup's marker code
// (lib/files.mjs) makes the location marker; OpenClaw's own `storage test` and `storage list` accept the location; a
// mock-model turn calls file_store and the object lands under f/<inst>/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dk } from "../harness/docker.mjs";
import { TEST_DIR } from "../harness/env.mjs";

const INST = "ab12cd";
const KEY_ID = "ocrt-g7-0123456789abcdef0123456789abcdef";
const SECRET = "5".repeat(64);
const KEY_FILE = "/tmp/st/files-key.json";

const CFG = {
  models: {
    providers: {
      mock: {
        baseUrl: "http://127.0.0.1:9101/v1",
        api: "openai-completions",
        apiKey: "x",
        models: [{ id: "mock", name: "mock", input: ["text"] }],
      },
    },
  },
  agents: { defaults: { model: { primary: "mock/mock" } } },
  tools: { toolSearch: false },
  // Same shape as cli/src/config.ts filesLocation(), plus keyFile: no /run/ocrt in this box (ocsup is not running).
  storage: {
    locations: {
      r2: {
        provider: "ochost-r2",
        settings: {
          endpoint: "http://127.0.0.1:18792",
          bucket: `oc-host-${INST}`,
          prefix: `f/${INST}`,
          keyFile: KEY_FILE,
        },
        encryption: "none",
      },
    },
  },
  plugins: { entries: { "ochost-storage": { enabled: true, config: { location: "r2" } } } },
};

const SCRIPT = `
mkdir -p /tmp/st /tmp/h; cp /cfg/openclaw.json /tmp/st/openclaw.json; cd /app
printf '{"accessKeyId":"${KEY_ID}","secretAccessKey":"${SECRET}"}\\n' > ${KEY_FILE}; chmod 400 ${KEY_FILE}
node /img/test/fakes/files-mock.mjs ${INST} ${KEY_ID} ${SECRET} > /tmp/mock.out 2>&1 & M=$!
node --input-type=module -e 'import {startCapProxy,FILES_PROXY_PORT} from "/opt/ocrt/lib/cap-proxy.mjs"; startCapProxy({port:FILES_PROXY_PORT,target:{host:"127.0.0.1",port:9102}}); setInterval(()=>{},1e6)' > /tmp/proxy.out 2>&1 & P=$!
sleep 1
echo "@@validate"; node openclaw.mjs config validate 2>&1
echo "@@uninit"; node openclaw.mjs storage list --json 2>&1
echo "@@marker"; node --input-type=module -e 'import {ensureFilesMarker} from "/opt/ocrt/lib/files.mjs"; console.log(await ensureFilesMarker({endpoint:"http://127.0.0.1:18792",bucket:"oc-host-${INST}",region:"auto",accessKey:"${KEY_ID}",secretKey:"${SECRET}"}, "${INST}"))' 2>&1
echo "@@list"; node openclaw.mjs storage list --json 2>&1
echo "@@test"; node openclaw.mjs storage test r2 --json 2>&1
echo "@@agent"; timeout 200 node openclaw.mjs agent --local --message "save a file to storage location r2" --session-id f1 --json 2>&1
kill -TERM $M $P; sleep 1
echo "@@mock"; cat /tmp/mock.out
`;

export default {
  name: "files-plugin",
  source: "docs/11 §8 (file storage, option A, as built)",
  rule: "Image ships ochost-storage as a root-owned bundled extension; offline: config with storage location r2 (provider ochost-r2, no credential) validates; ocsup's marker code makes a marker OpenClaw accepts; `storage list` shows r2 ok with target r2://oc-host-<inst>/f/<inst>; `storage test r2` writes, reads and deletes through ocsup's forwarder (127.0.0.1:18792) and a mock gate that checks SigV4 and the contract rule; a mock-model turn runs file_store save and notes/hello.md lands at f/<inst>/notes/hello.md.",
  timeoutMs: 600_000,
  async run(t) {
    const sh = (c) => dk(["run", "--rm", "--entrypoint", "sh", t.image, "-c", c]);
    const own = sh(
      "stat -c '%U %a' /app/dist/extensions/ochost-storage /app/dist/extensions/ochost-storage/index.js",
    ).out;
    t.check("plugin dir root-owned, not writable by others", /^root 755\nroot 644$/.test(own.trim()), own);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "files-"));
    fs.writeFileSync(path.join(dir, "openclaw.json"), JSON.stringify(CFG));
    const r = dk(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "1000",
        "-v",
        `${dir}:/cfg:ro`,
        "-v",
        `${path.dirname(TEST_DIR)}:/img:ro`,
        "-e",
        "HOME=/tmp/h",
        "-e",
        "OPENCLAW_STATE_DIR=/tmp/st",
        "-e",
        "OPENCLAW_CONFIG_PATH=/tmp/st/openclaw.json",
        "--entrypoint",
        "sh",
        t.image,
        "-c",
        SCRIPT,
      ],
      { timeoutMs: 550_000 },
    );
    fs.rmSync(dir, { recursive: true, force: true });
    const part = (k) => new RegExp(`@@${k}\\n([\\s\\S]*?)(?=\\n@@|$)`).exec(r.out)?.[1] ?? "";
    t.check("config valid", /Config valid/.test(part("validate")), part("validate").slice(-400));
    t.check(
      "before the marker: r2 is uninitialized (unavailable), not an error",
      /"unavailable"|"uninitialized"/.test(part("uninit")),
      part("uninit").slice(0, 600),
    );
    t.check("ocsup's marker code created the marker", /^created/m.test(part("marker")), part("marker"));
    t.check(
      "storage list: r2 ok, target names the install bucket and prefix",
      /"state": "ok"/.test(part("list")) && part("list").includes(`r2://oc-host-${INST}/f/${INST}`),
      part("list").slice(0, 800),
    );
    t.check(
      "storage test r2: write, read, verify, delete ok",
      /"state": "ok"/.test(part("test")),
      part("test").slice(0, 800),
    );
    const log = JSON.parse(/^LOG (.*)$/m.exec(part("mock"))?.[1] ?? "[]");
    const s3 = log.filter((x) => x.op);
    t.check(
      "every S3 request was signed with the gate key and allowed by the files rule",
      s3.length > 0 && s3.every((x) => x.sig && x.allow),
      s3,
    );
    t.check(
      "the plugin signed for the files forwarder host",
      s3.length > 0 && s3.every((x) => x.host === "127.0.0.1:18792"),
      [...new Set(s3.map((x) => x.host))],
    );
    t.check(
      "storage test cleaned up its probe object",
      s3.some((x) => x.op === "DeleteObject" && /\.openclaw-probe-/.test(x.key)),
      s3.map((x) => `${x.op} ${x.key}`),
    );
    t.check(
      "agent saw the file_store tool",
      log.some((x) => x.llm && x.tools.includes("file_store")),
      log.filter((x) => x.llm),
    );
    const objs = JSON.parse(/^OBJS (.*)$/m.exec(part("mock"))?.[1] ?? "[]");
    const saved = objs.find(([k]) => k === `f/${INST}/notes/hello.md`);
    t.check("file_store save landed at f/<inst>/notes/hello.md", saved?.[2] === "FILE-MARKER", objs);
    t.check("model saw ok from the tool", /done: SAW-OK/.test(part("agent")), part("agent").slice(-500));
    t.check(
      "marker kept, no stray keys outside f/<inst>/",
      objs.every(([k]) => k.startsWith(`f/${INST}/`)) &&
        objs.some(([k]) => k === `f/${INST}/openclaw-storage.json`),
      objs,
    );
  },
};
