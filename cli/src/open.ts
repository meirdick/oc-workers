// ochost open [--no-open] [--qr] (docs/10-cli-spec.md §1.2, W6). POST /ops/auth/code mints a single-use login
// link (5 min). Opens the browser, or prints a QR code for a phone (qrencode, when installed).
import { EXIT, type FlagSpec, flagBool, fmtTime, type OpsCtx, opsClient } from "./ops-lib.ts";

export const openFlags: FlagSpec = {
  open: { type: "boolean" },
  qr: { type: "boolean" },
};

export async function open(ctx: OpsCtx): Promise<number> {
  const ops = opsClient(ctx);
  const r = await ops.call<{ code?: string; url?: string; expiresAt?: number }>("POST", "/ops/auth/code");
  const link = r.body?.url ?? (r.body?.code ? `${ops.install.url}/_ochost/login/${r.body.code}` : "");
  if (!link) throw new Error("POST /ops/auth/code returned no code");
  const expiresAt = r.body?.expiresAt ?? ctx.now() + 10 * 60_000;
  // The link is a login: never in a log. It is printed once, on purpose, for the owner.
  if (ctx.out.json) {
    ctx.out.result(
      { ok: true, openUrl: link, openUrlExpiresAt: new Date(expiresAt).toISOString() },
      { raw: true },
    );
    return EXIT.ok;
  }
  const noOpen = ctx.args.flags.open === false || flagBool(ctx.args, "qr");
  ctx.out.secretLine(link);
  ctx.out.line(`single use, valid to ${fmtTime(expiresAt)} UTC`);
  if (flagBool(ctx.args, "qr")) {
    const q = await ctx.run("qrencode", ["-t", "ANSIUTF8", "-m", "1"], { input: link });
    if (q.code === 0) ctx.out.secretLine(q.stdout.trimEnd());
    else ctx.out.warn("no QR printer here — fix: install qrencode, or copy the link to the phone");
  }
  if (!noOpen) {
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    const o = await ctx.run(cmd, [link]);
    if (o.code !== 0) ctx.out.warn("could not open the browser — fix: copy the link above");
  }
  return EXIT.ok;
}
