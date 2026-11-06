// Pages the Worker serves itself (add §2.4, §5.4, §5.7): login, code landing, waking, the owner console at `/`.
// Small, no external assets; one inline script and style, allowed by a per-answer CSP nonce
// (ingress/headers.ts pageHeaders). Design rules: docs/18-owner-console-design.md.
import type { OwnerView } from "../core/types";
import type { Panel } from "../ctl/panel";
import { alertFix, type Check } from "../ctl/panel-checks";

/** Where "Open Control UI" goes. The Control UI is a single-page app: any path that is not `/` serves it. */
export const CONTROL_UI_PATH = "/chat";
/** The user docs (docs-site/). The only link off this origin. */
export const DOCS_URL = "https://oc-workers.mdick85.workers.dev/docs/";

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

// Neutral surfaces, one accent (--acc, blue: the one primary action), status colours (--ok, --warn, --bad, --info)
// for status and exceptions only. Text 14 px, labels 12 px, badges 11 px. No word here may name an install state:
// the anonymous login page carries this sheet and must not leak one.
const STYLE = `
:root{color-scheme:light dark;--canvas:#f7f7f8;--base:#fff;--tint:#fafafb;--recess:#f1f1f3;--fg:#1f1f23;--strong:#0b0b0d;
--mut:#6b6b74;--line:#e6e6e9;--line2:#d4d4d8;--acc:#0b5bd3;--acc-h:#0948a8;--on-acc:#fff;--link:#0b5bd3;--focus:#1f1f23;
--idle:#a1a1aa;--neu:#71717a;--ok:#059669;--warn:#ca8a04;--warn-t:#854d0e;--warn-b:#fdf6d8;--bad:#dc2626;--bad-t:#b91c1c;
--bad-b:#fdeeee;--info:#2563eb}
@media (prefers-color-scheme:dark){:root{--canvas:#0e0e10;--base:#18181b;--tint:#1c1c20;--recess:#26262b;--fg:#e8e8eb;
--strong:#fafafa;--mut:#a1a1aa;--line:#2a2a2f;--line2:#3f3f46;--acc:#2563eb;--acc-h:#3b72f0;--on-acc:#fff;--link:#7aa7ff;
--focus:#e8e8eb;--idle:#71717a;--neu:#a1a1aa;--ok:#34d399;--warn:#facc15;--warn-t:#fde68a;--warn-b:rgba(234,179,8,.14);
--bad:#f87171;--bad-t:#fecaca;--bad-b:rgba(239,68,68,.16);--info:#60a5fa}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--canvas);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:inherit}p{margin:0}form{margin:0}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-weight:500;line-height:20px;
padding:6px 12px;border:1px solid var(--line2);border-radius:6px;background:var(--base);color:var(--fg);cursor:pointer;
text-decoration:none;white-space:nowrap}
button:hover,.btn:hover{background:var(--recess)}
button:disabled{cursor:default;color:var(--mut);background:var(--recess)}
.pw button[name=act],.card button[type=submit]{background:var(--acc);border-color:var(--acc);color:var(--on-acc)}
.pw button[name=act]:hover,.card button[type=submit]:hover{background:var(--acc-h);border-color:var(--acc-h)}
.ghost{border-color:transparent;background:transparent;color:var(--mut)}
svg.i{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
body.c{display:grid;place-items:center;padding:16px}
main.card{width:100%;max-width:400px;background:var(--base);border:1px solid var(--line);border-radius:8px;padding:20px 24px}
.card h1{font-size:18px;font-weight:600;margin:0 0 6px;color:var(--strong)}.card p{color:var(--mut);margin:0 0 16px}
.card label{display:block;font-size:13px;font-weight:500;margin-bottom:6px}
.card input{width:100%;font:inherit;padding:7px 10px;border:1px solid var(--line2);border-radius:6px;background:var(--base);color:var(--fg)}
.card button{width:100%;margin-top:12px;padding:8px 12px}.card .err{color:var(--bad-t)}
.wrap{max-width:1120px;margin:0 auto;padding:0 16px 40px}
.bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;padding:14px 0}
.brand{display:flex;align-items:center;gap:8px;min-width:0;color:var(--mut)}.brand .sep{width:14px;height:14px}
.brand h1{font-size:16px;font-weight:600;margin:0;color:var(--strong);overflow-wrap:anywhere}
.nav{display:flex;align-items:center;gap:4px}
.note{margin:0 0 12px;padding:8px 12px;border-radius:6px;background:var(--recess)}.note.bad{background:var(--bad-b);color:var(--bad-t)}
.hero{display:grid;gap:16px;margin-bottom:16px;padding:16px;background:var(--base);border:1px solid var(--line);border-radius:8px}
.k{font-size:12px;color:var(--mut)}
.sw{display:flex;align-items:center;gap:10px;margin-top:2px;font-size:28px;line-height:34px;font-weight:600;color:var(--strong)}
.since{margin-left:20px;color:var(--mut)}
.sd{width:10px;height:10px;border-radius:50%;flex:none;background:var(--idle)}
.s-ok{background:var(--ok)}.s-mv{background:var(--info)}.s-bad{background:var(--bad)}
.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;margin:0}
.meta dt{font-size:12px;color:var(--mut)}.meta dd{margin:0;font-weight:500;overflow-wrap:anywhere}
.meta dd small{display:block;font-size:12px;font-weight:400;color:var(--mut)}
.pw{display:grid;gap:8px}.pw button{width:100%;padding:8px 16px}
.fixl{font-size:13px;color:var(--fg)}.fixl code,.cmd code{padding:1px 6px;border-radius:4px;background:var(--recess);overflow-wrap:anywhere;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.err{font-size:13px;color:var(--bad-t)}
dl.plain{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0}dl.plain dt{color:var(--mut)}dl.plain dd{margin:0}
.tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px;margin:0 0 20px;padding:3px;border-radius:8px;background:var(--recess)}
.tabs a{display:flex;align-items:center;justify-content:center;gap:6px;padding:6px 12px;border:1px solid transparent;border-radius:6px;color:var(--mut);font-weight:500;text-decoration:none;white-space:nowrap}
.tabs a:hover{color:var(--strong)}.tabs a[aria-current=page]{background:var(--base);border-color:var(--line);color:var(--strong)}
.n{min-width:18px;padding:0 5px;border-radius:9px;background:var(--line);color:var(--fg);font-size:11px;line-height:18px;text-align:center}
.n.hot{background:var(--bad-b);color:var(--bad-t)}
.tp,.g1{display:grid;gap:16px}.g2{display:grid;gap:16px;align-items:start}.g2>div{display:grid;gap:16px;min-width:0}
.sec{background:var(--base);border:1px solid var(--line);border-radius:8px;min-width:0;overflow:hidden}
.ch{display:flex;align-items:center;justify-content:space-between;gap:4px 12px;min-height:44px;padding:10px 16px;background:var(--tint);border-bottom:1px solid var(--line)}
h2{font-size:14px;font-weight:600;margin:0;color:var(--strong)}.ch .k{margin-left:auto;text-align:right}
.go{display:inline-flex;align-items:center;gap:4px;color:var(--link);font-size:13px;font-weight:500;text-decoration:none;white-space:nowrap}
.go:hover{text-decoration:underline}
.bd{padding:12px 16px}.emp{padding:16px;color:var(--mut)}.sub{padding:10px 16px 0;font-size:13px;color:var(--mut)}
.strip{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
.strip>*{display:block;padding:14px 16px;min-width:0;text-decoration:none;border-top:1px solid var(--line)}
.strip>:nth-child(-n+2){border-top:0}.strip>:nth-child(2n){border-left:1px solid var(--line)}
a.cell:hover{background:var(--tint)}.cell .k{display:flex;align-items:center;justify-content:space-between;gap:6px}
.big{display:block;margin-top:2px;font-size:20px;line-height:28px;font-weight:600;color:var(--strong)}
.cell small{display:block;font-size:12px;color:var(--mut)}
table{width:100%;border-collapse:collapse}
th{padding:8px 16px;font-size:12px;font-weight:500;color:var(--mut);text-align:left;white-space:nowrap}
td{padding:10px 16px;border-top:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
th.r,td.ac,td.r{text-align:right}td.nm{font-weight:500;color:var(--strong)}
td small,.tm small{display:block;font-size:12px;color:var(--mut)}.mut{color:var(--mut)}.ml{display:none}
.st{display:inline-flex;align-items:baseline;gap:8px}.dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--idle);transform:translateY(-1px)}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
.cmd{display:inline-flex;align-items:flex-start;gap:6px;font-size:13px;text-align:left;max-width:100%}.cmd svg{margin-top:2px;color:var(--mut)}
.fixr{display:block;margin-top:4px;font-size:13px;color:var(--mut)}.fixr code{color:var(--fg)}
.ac form{display:inline-block}.ac button,.ex button{padding:4px 12px;font-size:13px}
.ex{position:relative;padding:12px 16px 12px 18px;border-top:1px solid var(--line)}.ex:first-child{border-top:0}
.ex::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--neu)}
.ex.hi::before{background:var(--bad)}.ex.wa::before{background:var(--warn)}
.exh{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}.exh .nm{font-weight:600;color:var(--strong);overflow-wrap:anywhere}
.exh .t{margin-left:auto;font-size:12px;color:var(--mut);white-space:nowrap}
.ex p{margin-top:4px;font-size:13px}.ex .fixl{margin-top:6px}.ex form{margin-top:10px}
a.ex{display:block;text-decoration:none}a.ex:hover{background:var(--tint)}
.bdg{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:500;line-height:18px;background:var(--recess);color:var(--fg)}
.hi .bdg{background:var(--bad-b);color:var(--bad-t)}.wa .bdg{background:var(--warn-b);color:var(--warn-t)}
pre{margin:8px 0 0;padding:8px;border-radius:6px;background:var(--recess);font-size:12px;white-space:pre-wrap;word-break:break-word}
.use{padding:10px 16px;border-top:1px solid var(--line)}.use:first-child{border-top:0}
.use p{display:flex;justify-content:space-between;gap:8px}.use .v{font-variant-numeric:tabular-nums}
.meter{height:6px;margin:6px 0 2px;border-radius:3px;background:var(--recess)}
.meter i{display:block;height:100%;border-radius:3px;background:var(--neu)}.wa .meter i{background:var(--warn)}.hi .meter i{background:var(--bad)}
.bd.line{border-top:1px solid var(--line)}.bd.line .k{display:inline}
.filt{display:flex;flex-wrap:wrap;gap:6px;padding:12px 16px;border-bottom:1px solid var(--line)}
.filt a{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid var(--line2);border-radius:14px;font-size:13px;text-decoration:none;color:var(--fg)}
.filt a[aria-current=page]{border-color:var(--strong);color:var(--strong);font-weight:500}
.tm{white-space:nowrap;font-variant-numeric:tabular-nums}
@media (max-width:719px){thead{display:none}td.tm small,td:empty{display:none}tbody tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:10px 16px;border-top:1px solid var(--line)}
td{padding:0;border:0}td.w,td.cm{grid-column:1/-1}td.ac,td.tm{grid-column:2;grid-row:1}.ml{display:inline}td.r{text-align:left}}
@media (min-width:720px){.tabs{display:inline-flex;flex-wrap:wrap}.strip{grid-template-columns:repeat(4,minmax(0,1fr))}
.strip>*{border-top:0}.strip>*+*{border-left:1px solid var(--line)}}
@media (min-width:880px){.wrap{padding:0 24px 48px}.hero{grid-template-columns:minmax(160px,auto) minmax(0,1fr) auto;column-gap:40px;align-items:center;padding:20px 24px}
.meta{grid-template-columns:repeat(4,minmax(0,1fr))}.hero>.fixl{grid-column:1/-1}.pw{justify-items:end;max-width:300px}.pw button{width:auto;min-width:140px}
.g2{grid-template-columns:minmax(0,1fr) 300px}table{table-layout:fixed}th.c1{width:24%}th.c2{width:120px}th.c3{width:34%}
th.c4{width:210px}th.c5{width:96px}td.cm{text-align:right}}
${Array.from({ length: 21 }, (_, i) => `.w${i}{width:${i * 5}%}`).join("")}`;

// Lucide icons (lucide.dev, ISC), stroke 2, 16 px.
const icon = (paths: string, label = "") =>
  `<svg class="i" viewBox="0 0 24 24"${label ? ` role="img" aria-label="${label}"` : ' aria-hidden="true"'}>${paths}</svg>`;
const I = {
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  out: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  logout: '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
  term: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
};

/** Centered card: login, code and waking pages. */
function shell(title: string, nonce: string, body: string, script = ""): string {
  return doc(title, nonce, `<body class="c"><main class="card">${body}</main>`, script);
}

function doc(title: string, nonce: string, body: string, script: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style nonce="${nonce}">${STYLE}</style></head>
${body}${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
}

/**
 * GET /_ochost/login, and `/` with no owner session: the owner token once. `retry`: this navigation came from
 * another site (the Access login redirect, a link in a mail), so the browser held back the SameSite=Strict owner
 * cookie; one same-origin reload by script sends it. The second load is same-origin, so this never loops.
 */
export function loginPage(nonce: string, error?: string, retry = false): string {
  return shell(
    "oc-workers sign in",
    nonce,
    `<h1>Sign in</h1><p>Paste the owner token (<span class="mono">.oc-host/control-token</span>). You do this once per browser.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/_ochost/login"><label for="t">Owner token</label>
<input id="t" name="token" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Sign in</button></form>`,
    retry ? "location.replace(location.href);" : "",
  );
}

/**
 * GET /_ochost/login/<code> (S1.5): a button only. The code is used by the same-origin POST it sends, so a
 * link preview or mail scanner that fetches the link leaves it valid. The script keeps the link's #fragment.
 */
export function codeConfirmPage(nonce: string): string {
  return shell(
    "oc-workers sign in",
    nonce,
    `<h1>Sign in to oc-workers</h1><p>Continue to sign in in this browser.</p>
<form method="post"><input type="hidden" name="h" id="h" value=""><button type="submit" autofocus>Continue</button></form>`,
    "document.getElementById('h').value = location.hash;",
  );
}

/** POST /_ochost/login/<code>: the cookie is set on this answer; a same-origin navigation to `/` + hash follows. */
export function codePage(nonce: string, hash = ""): string {
  const h = /^#[A-Za-z0-9._~=&%+/-]{0,512}$/.test(hash) ? hash : "";
  return shell(
    "oc-workers sign in",
    nonce,
    `<h1>Signed in</h1><p>Opening the status page. <a href="/">Continue</a></p>`,
    `location.replace('/' + ${JSON.stringify(h)});`,
  );
}

export function codeFailedPage(nonce: string): string {
  return shell(
    "oc-workers sign in",
    nonce,
    `<h1>Link used or expired</h1><p>Run <span class="mono">ochost open</span> for a new link, or <a href="/_ochost/login">sign in with the token</a>.</p>`,
  );
}

/** Waking page (add §2.4): 200 no-store, shows the phase and elapsed seconds, polls wake-status every 2 s, reloads the same path when started. */
export function wakingPage(nonce: string): string {
  return shell(
    "OpenClaw is waking",
    nonce,
    `<h1>Waking, about 45 s</h1><p>The install was asleep. This page reloads when OpenClaw is ready.</p>
<p id="s" role="status" aria-live="polite">Phase: restoring. 0 s.</p>`,
    `(function(){var t0=Date.now(),el=document.getElementById('s');
function ph(st){return st==='running'?'ready':st==='starting'||st==='maintenance'?'starting':'restoring'}
var last='';function show(st){last=st;el.textContent='Phase: '+ph(st)+' ('+st+'). '+Math.round((Date.now()-t0)/1000)+' s.'}
function tick(){fetch('/_ochost/wake-status',{credentials:'same-origin',cache:'no-store'}).then(function(r){
if(r.status===404||r.status===401){location.href='/_ochost/login';return null}return r.json()}).then(function(j){
if(!j)return;if(j.started){show('running');location.replace(location.pathname+location.search+location.hash);return}
show(j.state);setTimeout(tick,2000)
}).catch(function(){setTimeout(tick,2000)})}
setInterval(function(){if(last)show(last)},1000);
tick()})();`,
  );
}

/** Duration in words: 45 s, 12 min, 5 h, 3 d. */
export function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const usd = (n: number) => (n <= 0 ? "$0.00" : n < 0.01 ? "under $0.01" : `$${n.toFixed(2)}`);

/** running, asleep or starting, from the Runtime DO state. */
export function stateWord(state: string): "running" | "asleep" | "starting" | "stopped" {
  if (state === "running") return "running";
  if (state === "asleep" || state === "asleep-unconfirmed") return "asleep";
  if (state === "stopped" || state === "none" || state === "not-installed") return "stopped";
  return "starting";
}

const NOTICES: Record<string, string> = {
  acked: "Alert acknowledged",
  raised: "Daily limit doubled",
  archive: "Archive requested. The install wakes to take it",
  "drill-ok": "Restore drill passed",
  "drill-failed": "Restore drill failed",
  approved: "Pairing approved",
  "panel-failed": "That did not work",
  wake: "Wake requested. This page reloads while it starts",
  start: "Start requested. This page reloads while it starts",
  "start-failed": "Start refused",
  sleep: "Sleep started. The install flushes and stops in about a minute",
  "sleep-refused": "Sleep refused",
  "no-install": "No active install yet. Run ochost status",
};
const BAD_NOTICE = new Set(["drill-failed", "panel-failed", "start-failed", "sleep-refused"]);

/** The one state-driven button on `/`. `act` null = shown disabled (the state is moving on its own). */
export interface PowerButton {
  act: "wake" | "sleep" | "start" | null;
  label: string;
  /** Retry now: the open alert's fix line, shown beside the button. */
  fix?: string;
}

const restoreBlocked = (v: OwnerView) =>
  (v.ladderClass ?? "").startsWith("restore-blocked") && v.state !== "running" && v.state !== "maintenance";

/**
 * asleep → Wake now; starting → Waking, N s (disabled); running → Sleep now; quiescing → Going to sleep (disabled;
 * no Cancel: the Runtime DO has no route that aborts a sleep op); backoff or restore-blocked → Retry now (owner
 * start) with the alert's fix line; stopped by the owner → Start.
 */
export function powerButton(v: OwnerView, fix?: string): PowerButton {
  const st = v.state;
  if (st === "stopped" || st === "new") return { act: "start", label: "Start" };
  if (st === "backoff" || restoreBlocked(v))
    return { act: "start", label: "Retry now", ...(fix ? { fix } : {}) };
  if (st === "running" || st === "maintenance") return { act: "sleep", label: "Sleep now" };
  if (st === "asleep" || st === "asleep-unconfirmed") return { act: "wake", label: "Wake now" };
  if (st === "quiescing" || st === "draining") return { act: null, label: "Going to sleep" };
  if (st === "stopping") return { act: null, label: "Stopping" };
  if (st === "starting" || st === "waiting-capacity")
    return { act: null, label: v.stateAt ? `Waking, ${fmtSpan(v.now - v.stateAt)}` : "Waking" };
  return { act: null, label: "No install" };
}

/** The fix line for Retry now: the open alert of the ladder class, else the newest high one, else the newest. */
function retryFix(v: OwnerView, p?: Panel | null): string | undefined {
  const open = p
    ? p.alerts.open.map((a) => ({ cls: a.class, sev: a.severity, fix: a.fix }))
    : v.alerts.filter((a) => a.open).map((a) => ({ cls: a.class, sev: a.severity, fix: alertFix(a.class) }));
  const want = v.ladderClass ?? "";
  const a =
    open.find((x) => x.cls === want || x.cls.startsWith("restore-blocked") || x.cls === "ctl-rewound") ??
    open.find((x) => x.sev === "high") ??
    open[0];
  return a ? `${a.fix} (alert ${a.cls})` : undefined;
}

/** One form; the button's name and value carry the action, so it works with JavaScript off. */
function powerHtml(b: PowerButton, refused: string | null): string {
  const btn = b.act
    ? `<form method="post" action="/_ochost/power"><button type="submit" name="act" value="${b.act}">${esc(b.label)}</button></form>`
    : `<button type="button" disabled>${esc(b.label)}</button>`;
  const why =
    refused !== null
      ? `<p class="err" role="alert">Sleep refused${refused ? `: ${esc(refused)}` : ""}.</p>`
      : "";
  // The fix line is a sibling of .pw: on wide screens it takes the full width of the state card.
  const m = b.fix ? /^(.*?)( \(alert [^)]*\))?$/.exec(b.fix) : null;
  const fix = m
    ? `<p class="fixl">Do this: <code class="mono">${esc(m[1] ?? "")}</code>${esc(m[2] ?? "")}</p>`
    : "";
  return `<div class="pw">${btn}${why}</div>${fix}`;
}

/** Reload every 5 s while the state moves on its own or right after a button. */
const moving = (v: OwnerView, code?: string) =>
  ["starting", "waiting-capacity", "quiescing", "draining", "stopping", "asleep-unconfirmed"].includes(
    v.state,
  ) ||
  code === "wake" ||
  code === "start" ||
  code === "sleep";

/** The focal headline: one word for the state, its dot, and how long. */
function headline(v: OwnerView): { word: string; dot: string; since: string } {
  const st = v.state;
  const [word, dot] =
    st === "running" || st === "maintenance"
      ? ["Running", "s-ok"]
      : st === "backoff"
        ? ["Retrying", "s-bad"]
        : restoreBlocked(v)
          ? ["Blocked", "s-bad"]
          : st === "asleep" || st === "asleep-unconfirmed"
            ? ["Asleep", ""]
            : st === "starting" || st === "waiting-capacity"
              ? ["Waking", "s-mv"]
              : st === "quiescing" || st === "draining"
                ? ["Going to sleep", "s-mv"]
                : st === "stopping"
                  ? ["Stopping", "s-mv"]
                  : st === "stopped" || st === "new"
                    ? ["Stopped", ""]
                    : ["No install", ""];
  const raw = ["running", "asleep", "starting", "stopped", "stopping", "quiescing"].includes(st) ? "" : st;
  const parts = [v.stateAt ? `for ${fmtSpan(v.now - v.stateAt)}` : "", raw].filter(Boolean);
  return { word, dot, since: parts.join(" · ") };
}

const signOut = `<form method="post" action="/_ochost/logout"><button type="submit" class="ghost">${icon(I.logout)}Sign out</button></form>`;

/** Console frame: the bar (install name, Open Control UI, Sign out), the notice, then the body. */
function consolePage(nonce: string, inst: string | null, note: string, body: string, script: string): string {
  const sep = `<svg class="i sep" viewBox="0 0 24 24" aria-hidden="true">${I.chev}</svg>`;
  const bar = `<header class="bar"><nav class="brand" aria-label="Breadcrumb">${icon(I.cloud)}<span>oc-workers</span>${
    inst ? `${sep}<h1>${esc(inst)}</h1>` : "<h1>oc-workers</h1>"
  }</nav><nav class="nav" aria-label="Install"><a class="ghost btn" href="${DOCS_URL}" rel="noopener">Docs</a><a class="btn" href="${CONTROL_UI_PATH}">Open Control UI${icon(I.out)}</a>${signOut}</nav></header>`;
  return doc(
    inst ? `${inst} · oc-workers` : "oc-workers",
    nonce,
    `<body><div class="wrap">${bar}<main>${note}${body}</main></div>`,
    script,
  );
}

function heroHtml(v: OwnerView, meta: string, power: string): string {
  const h = headline(v);
  return `<section class="hero" aria-label="Install state"><div><p class="k">Install state</p>
<p class="sw" id="st"><span class="sd ${h.dot}" aria-hidden="true"></span>${esc(h.word)}</p>${
    h.since ? `<p class="since">${esc(h.since)}</p>` : ""
  }</div>${meta}${power}</section>`;
}

/**
 * GET `/` with an owner session. With the panel facts: the console (state card, tab row, one tab). Without (the
 * Control DO answered ownerView only): the state card with the two newest alerts. `v` null = the Control DO did not
 * answer. While the state moves the page reloads every 5 s.
 */
export function statusPage(
  nonce: string,
  v: OwnerView | null,
  notice?: { code: string; why?: string },
  panel?: Panel | null,
  q: { tab?: string | null; kind?: string | null } = {},
): string {
  const n = notice && NOTICES[notice.code];
  const note = n
    ? `<p class="note${BAD_NOTICE.has(notice?.code ?? "") ? " bad" : ""}" role="status">${esc(n)}${notice?.why ? `: ${esc(notice.why)}` : ""}.</p>`
    : "";
  if (!v)
    return consolePage(
      nonce,
      null,
      note,
      `<section class="hero"><p>Status is not available now. Reload in a few seconds.</p></section>`,
      "",
    );
  const power = powerButton(v, retryFix(v, panel));
  // A sleep refusal shows beside Sleep now (the rule's reason); the top notice is for everything else.
  const refused = notice?.code === "sleep-refused" && power.act === "sleep" ? (notice.why ?? "") : null;
  const top = refused !== null ? "" : note;
  const last = v.lastActivityAt ? `${fmtSpan(v.now - v.lastActivityAt)} ago` : "none";
  const word = stateWord(v.state);
  const next =
    v.nextWakeAt && v.nextWakeAt > v.now
      ? { main: `in ${fmtSpan(v.nextWakeAt - v.now)}`, sub: iso(v.nextWakeAt) }
      : word === "asleep"
        ? { main: "On a message", sub: "or a login" }
        : { main: "None scheduled", sub: "" };
  const fast = moving(v, notice?.code);
  const pw = powerHtml(power, refused);
  if (panel) return panelPage(nonce, v, top, panel, fast, pw, { last, next }, q);
  const alerts = v.alerts.length
    ? v.alerts
        .slice(0, 2)
        .map(
          (a) =>
            `<div>${esc(a.class)} (${esc(a.severity)})${a.at ? `, ${fmtSpan(v.now - a.at)} ago` : ""}${a.open ? ", open" : ""}</div>`,
        )
        .join("")
    : "none";
  const meta = `<dl class="plain"><dt>Last activity</dt><dd>${esc(last)}</dd><dt>Next wake</dt><dd>${esc(next.main)}${
    next.sub ? ` (${esc(next.sub)})` : ""
  }</dd><dt>Snapshots</dt><dd>${v.snapshots}</dd><dt>Alerts</dt><dd>${alerts}</dd></dl>`;
  return consolePage(
    nonce,
    v.inst,
    top,
    heroHtml(v, meta, pw),
    fast ? "setTimeout(function(){location.replace('/')},5000);" : "",
  );
}

// ---------------------------------------------------------------- owner console
// Below the state card: one tab row, one tab per content kind (docs/18). Each tab is `/?tab=<id>`, rendered on the
// server: links, no script. An item lives in one tab only. Status: a dot and a word. Exception (alert): a left
// border and a badge. Action: a button or a command, in Setup and Alerts only. Log: a neutral table.

export const TABS = [
  ["overview", "Overview"],
  ["log", "Alerts and log"],
  ["setup", "Setup"],
] as const;
/** Old tab names (links in docs and bookmarks) → where that content lives now. */
const OLD_TABS: Record<string, Tab> = {
  health: "overview",
  cost: "overview",
  activity: "log",
  alerts: "log",
};
export type Tab = (typeof TABS)[number][0];
const KINDS = [
  ["wake", "Wakes"],
  ["sleep", "Sleeps"],
  ["restart", "Restarts"],
  ["archive", "Archives"],
] as const;

type Res = Check["result"];
const DOT: Record<Res, [string, string]> = {
  PASS: ["ok", "OK"],
  WARN: ["warn", "Warning"],
  FAIL: ["bad", "Failing"],
};
const SEV: Record<string, [string, string]> = { high: ["hi", "High"], warn: ["wa", "Warning"] };
const sev = (s: string): [string, string] => SEV[s] ?? ["", s.charAt(0).toUpperCase() + s.slice(1)];

/** `ochost x (why)` → `ochost x`: the command part of a fix line. */
const cmdOf = (fix: string) => fix.replace(/\s+\(.*\)$/, "");
const cmdHtml = (cmd: string) =>
  `<span class="cmd">${icon(I.term, "Run in a terminal")}<code>${esc(cmd)}</code></span>`;
/** Status: a dot (none = grey, not a problem) and the words. */
const stat = (r: Res | null | undefined, words: string) =>
  r === undefined
    ? `<span class="mut">${esc(words)}</span>`
    : `<span class="st"><span class="dot ${r ? DOT[r][0] : ""}" aria-hidden="true"></span><span>${esc(words)}</span></span>`;
const tabHref = (t: Tab, extra = "") => (t === "overview" && !extra ? "/" : `/?tab=${t}${extra}`);
const go = (href: string, label: string) => `<a class="go" href="${href}">${esc(label)}${icon(I.arrow)}</a>`;
const ago = (now: number, at: number | null) =>
  at ? `<time datetime="${new Date(at).toISOString()}">${fmtSpan(now - at)} ago</time>` : "";

/** A card: title row (title, optional muted aside, optional arrow link), then the body. */
const card = (id: string, title: string, body: string, o: { aside?: string; link?: string } = {}) =>
  `<section class="sec" aria-labelledby="${id}"><div class="ch"><h2 id="${id}">${title}</h2>${
    o.aside ? `<span class="k">${o.aside}</span>` : ""
  }${o.link ?? ""}</div>${body}</section>`;

/** `head`: [label, class]; the class sets the column width on wide screens (c1-c5) and right alignment (r). */
const table = (label: string, head: [string, string][], rows: string[]) =>
  `<table aria-label="${label}"><thead><tr>${head.map(([h, c]) => `<th scope="col"${c ? ` class="${c}"` : ""}>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;

const post = (act: string, fields: Record<string, string>, label: string) =>
  `<form method="post" action="/_ochost/panel/${act}">${Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("")}<button type="submit">${esc(label)}</button></form>`;

/** One Setup row: what, its state, and ONE button or the exact command. `todo`: counts on the tab and Overview. */
interface SetupRow {
  group: "ch" | "in" | "bk";
  name: string;
  state: string;
  /** null: a grey dot (off, not a problem); undefined: no dot (the row has no state, only a description). */
  result?: Res | null;
  button?: string;
  cmd?: string;
  todo: boolean;
}

function setupRows(p: Panel): SetupRow[] {
  const find = (n: string) => p.connected.find((r) => r.name === n);
  const bad = (r?: Check) => !!r && r.result !== "PASS";
  const rows: SetupRow[] = [];
  const tg = find("channel telegram");
  rows.push(
    tg
      ? {
          group: "ch",
          name: "Telegram",
          state: tg.result === "PASS" ? "Connected, webhook set" : tg.detail,
          result: tg.result,
          ...(tg.fix ? { cmd: cmdOf(tg.fix) } : {}),
          todo: bad(tg),
        }
      : {
          group: "ch",
          name: "Telegram",
          state: "Not connected",
          result: null,
          cmd: "ochost channels add telegram",
          todo: true,
        },
  );
  for (const q of p.channels?.pairing ?? [])
    rows.push({
      group: "ch",
      name: `Pairing ${q.code}`,
      state: `${q.name || "unknown"} (${q.id}), ${plural(q.count, "message")}, ${q.held} held`,
      result: "WARN",
      button: post("approve", { code: q.code }, "Approve"),
      todo: true,
    });
  const other = p.connected.filter((r) => r.name.startsWith("channel ") && r.name !== "channel telegram");
  const otherBad = other.find((r) => r.result !== "PASS");
  rows.push({
    group: "ch",
    name: "Other channels",
    state: other.length ? other.map((r) => r.name.slice(8)).join(", ") : "None",
    result: otherBad?.result ?? (other.length ? "PASS" : null),
    cmd: otherBad?.fix ? cmdOf(otherBad.fix) : "ochost channels add slack|discord|twilio",
    todo: !!otherBad,
  });
  const al = find("alerts sink");
  if (al)
    rows.push({
      group: "ch",
      name: "Alert channel",
      state: al.detail,
      result: al.result,
      ...(al.fix ? { cmd: cmdOf(al.fix) } : {}),
      todo: bad(al),
    });
  const ac = find("access");
  if (ac)
    rows.push({
      group: "in",
      name: "Access",
      state: ac.detail.startsWith("on") ? `On, ${ac.detail.slice(4)}` : "Off (opt-in)",
      result: ac.fix ? null : ac.result,
      ...(ac.fix ? { cmd: cmdOf(ac.fix) } : {}),
      todo: false,
    });
  const sb = find("sandbox");
  if (sb) {
    const off = sb.detail.startsWith("off");
    rows.push({
      group: "in",
      name: "Sandbox",
      state: off ? "Off (opt-in)" : (sb.detail.split(";")[0] ?? ""),
      result: off ? null : sb.result,
      cmd: sb.fix ? cmdOf(sb.fix) : off ? "ochost sandbox on" : "ochost sandbox status",
      todo: !off && bad(sb),
    });
  }
  const mo = find("model");
  if (mo)
    rows.push({
      group: "in",
      name: "Model",
      state: mo.detail.split(", gateway")[0] ?? mo.detail,
      cmd: "ochost model set <id>",
      todo: false,
    });
  const up = find("install");
  if (bad(up))
    rows.push({
      group: "in",
      name: "Upgrade",
      state: "A newer image is available",
      result: up?.result ?? null,
      cmd: cmdOf(up?.fix ?? ""),
      todo: true,
    });
  const rd = find("config render");
  if (bad(rd))
    rows.push({
      group: "in",
      name: "Config render",
      state: rd?.detail ?? "",
      result: rd?.result ?? null,
      cmd: cmdOf(rd?.fix ?? ""),
      todo: true,
    });
  for (const b of p.budgets ?? [])
    if (b.row.result !== "PASS" && b.next > b.limit)
      rows.push({
        group: "in",
        name: `Daily ${b.verb} limit`,
        state: `${b.row.detail} today; Raise sets ${b.next}${b.unit}`,
        result: b.row.result,
        button: post("raise", { verb: b.verb, from: String(b.limit) }, "Raise"),
        todo: true,
      });
  rows.push(
    {
      group: "bk",
      name: "Archive",
      state: "Wakes the install and writes a full archive to R2",
      button: post("archive", {}, "Archive now"),
      todo: false,
    },
    {
      group: "bk",
      name: "Restore drill",
      state: "Restores the newest archive into a throw-away instance",
      button: post("drill", {}, "Restore drill"),
      todo: false,
    },
  );
  return rows;
}

function setupTab(rows: SetupRow[]): string {
  const tr = (r: SetupRow) =>
    `<tr><td class="nm">${esc(r.name)}</td><td class="w">${stat(r.result, r.state)}</td>${
      r.button ? `<td class="ac">${r.button}</td>` : `<td class="cm">${r.cmd ? cmdHtml(r.cmd) : ""}</td>`
    }</tr>`;
  const part = (g: SetupRow["group"], id: string, title: string, aside: string, link?: string) => {
    const rs = rows.filter((r) => r.group === g);
    const todo = rs.filter((r) => r.todo).length;
    return card(
      id,
      title,
      table(
        title,
        [
          ["Item", "c1"],
          ["State", ""],
          ["Action", "c3 r"],
        ],
        rs.map(tr),
      ),
      {
        aside: todo ? `${todo} to do` : aside,
        ...(link ? { link } : {}),
      },
    );
  };
  return `<div class="g1">${part("ch", "h-ch", "Channels and alerts", "Connect")}${part(
    "in",
    "h-in",
    "Install",
    "Configure",
  )}${part("bk", "h-bk", "Backups", "On demand", go(tabHref("log", "&kind=archive"), "Archive log"))}</div>`;
}

/** Health: the read-only status report. Rows that Setup owns (access, alert channel, sandbox) are not here. */
/** Checks that Setup shows as rows with a command; Health and Overview leave them out. */
const SETUP_CHECKS = new Set(["access", "alerts sink", "sandbox"]);

/** Health: the Connected and Backups tables, on the Overview. */
function healthHtml(p: Panel): string {
  const ch = p.channels;
  const wake: Check = {
    name: "wake list",
    result: "PASS",
    detail: `${plural(ch.wake.userIds.length, "user")}, ${plural(ch.wake.groupChatIds.length, "group")}${ch.wake.userIds.length ? `: ${ch.wake.userIds.join(", ")}` : ""}`,
  };
  const held: Check = ch.heldInbox
    ? { name: "held inbox", result: "WARN", detail: plural(ch.heldInbox, "row"), fix: "ochost inbox list" }
    : { name: "held inbox", result: "PASS", detail: "0 rows" };
  const tr = (r: Check) =>
    `<tr><td class="nm">${esc(r.name)}</td><td class="tm">${stat(r.result, DOT[r.result][1])}</td><td class="w">${esc(r.detail)}${
      r.fix && r.result !== "PASS" ? `<span class="fixr">Fix: <code>${esc(r.fix)}</code></span>` : ""
    }</td></tr>`;
  const connected = p.connected.filter((r) => !SETUP_CHECKS.has(r.name));
  const sum = (rs: Check[]) => {
    const f = rs.filter((r) => r.result === "FAIL").length;
    const w = rs.filter((r) => r.result === "WARN").length;
    return f || w
      ? [f ? `${f} failing` : "", w ? plural(w, "warning") : ""].filter(Boolean).join(", ")
      : "All OK";
  };
  const crows = [...connected, wake, held];
  const brows = p.backups?.rows ?? [];
  const head: [string, string][] = [
    ["Check", "c1"],
    ["Status", "c2"],
    ["Detail", ""],
  ];
  return `${p.probes?.asleep ? `<p class="note">Install asleep: the model and webhook rows show the last check.</p>` : ""}${card(
    "h-con",
    "Connected",
    table("Connected", head, crows.map(tr)),
    { aside: sum(crows) },
  )}${card("h-bak", "Backups", table("Backups", head, brows.map(tr)), {
    aside: sum(brows),
    link: go(tabHref("log", "&kind=archive"), "Archive log"),
  })}`;
}

/** Daily budgets (caps): one meter per verb. On the Cost tab; a limit at warning or failing has Raise on Setup. */
function budgetsHtml(p: Panel): string {
  return (p.budgets ?? [])
    .map((b) => {
      const c = b.row.result === "FAIL" ? "hi" : b.row.result === "WARN" ? "wa" : "";
      return `<div class="use ${c}"><p><span>${esc(b.verb)}</span><span class="v">${esc(b.row.detail.replace(/ \(.*/, ""))}</span></p><div class="meter"><i class="w${Math.max(
        0,
        Math.min(20, Math.round(b.pct * 20)),
      )}"></i></div>${
        b.row.result === "PASS"
          ? `<span class="vh">OK</span>`
          : `<span class="k">${stat(b.row.result, `${DOT[b.row.result][1]}, ${Math.round(b.pct * 100)}% used`)}</span>`
      }</div>`;
    })
    .join("");
}

/** Activity: the log. One table, newest first, filter by kind with links. */
function activityHtml(p: Panel, kind: string | null): string {
  const all = (p.events ?? []).filter((e) => KINDS.some(([k]) => k === e.kind));
  const k = KINDS.some(([x]) => x === kind) ? kind : null;
  const rows = all.filter((e) => !k || e.kind === k);
  const filt = `<nav class="filt" aria-label="Filter by kind"><a href="${tabHref("log")}"${k ? "" : ' aria-current="page"'}>All <span class="n">${all.length}</span></a>${KINDS.map(
    ([x, label]) =>
      `<a href="${tabHref("log", `&kind=${x}`)}"${k === x ? ' aria-current="page"' : ""}>${label} <span class="n">${all.filter((e) => e.kind === x).length}</span></a>`,
  ).join("")}</nav>`;
  const tr = (e: Panel["events"][number]) =>
    `<tr><td class="tm">${ago(p.now, e.at)}<small>${iso(e.at)}</small></td><td class="nm">${esc(e.text)}</td><td class="r w mut">${typeof e.ms === "number" ? `<span class="ml">Took </span>${fmtSpan(e.ms)}` : ""}</td></tr>`;
  return card(
    "h-act",
    "Activity",
    `${filt}${
      rows.length
        ? table(
            "Activity",
            [
              ["Time", "c4"],
              ["Event", ""],
              ["Took", "c5 r"],
            ],
            rows.map(tr),
          )
        : `<p class="emp">No ${k ? `${KINDS.find(([x]) => x === k)?.[1].toLowerCase()} ` : "events "}in the last 30 days</p>`
    }`,
    { aside: "Last 30 days, newest first" },
  );
}

/** One open alert: border and badge, detail, the fix line, the Doctor tail, Acknowledge. */
function openAlert(p: Panel, a: Panel["alerts"]["open"][number]): string {
  const [c, t] = sev(a.severity);
  return `<div class="ex ${c}" id="a-${esc(a.class)}"><div class="exh"><span class="bdg">${esc(t)}</span><span class="nm">${esc(a.class)}</span><span class="t">${ago(p.now, a.at)}${a.count > 1 ? `, ${a.count} times` : ""}</span></div>${
    a.detail ? `<p>${esc(a.detail)}</p>` : ""
  }<p class="fixl">Do this: <code>${esc(a.fix)}</code></p>${
    a.class === "doctor-failed" && p.alerts.doctorTail ? `<pre>${esc(p.alerts.doctorTail)}</pre>` : ""
  }${post("ack", { class: a.class }, "Acknowledge")}</div>`;
}

/** Alerts and log: open alerts (Acknowledge), the activity log, then the closed alerts. */
function logTab(p: Panel, kind: string | null): string {
  const open = p.alerts.open;
  const closed = p.alerts.closed ?? [];
  const tr = (a: Panel["alerts"]["open"][number]) =>
    `<tr><td class="nm">${esc(a.class)}<small>${esc(sev(a.severity)[1])}${a.count > 1 ? `, ${a.count} times` : ""}</small></td><td class="w mut">${esc(a.detail || "-")}</td><td class="tm r">${ago(p.now, a.at)}</td></tr>`;
  return `<div class="g1">${card(
    "h-open",
    "Open alerts",
    open.length ? open.map((a) => openAlert(p, a)).join("") : `<p class="emp">No open alerts</p>`,
    { aside: open.length ? plural(open.length, "alert") : "" },
  )}${activityHtml(p, kind)}${card(
    "h-closed",
    "Closed alerts",
    closed.length
      ? table(
          "Closed alerts",
          [
            ["Alert", "c1"],
            ["Last detail", ""],
            ["Last sent", "c5 r"],
          ],
          closed.map(tr),
        )
      : `<p class="emp">No closed alerts in the last 30 days</p>`,
    { aside: "Newest first" },
  )}</div>`;
}

/** Cost on the Overview: the month strip with the cost guard line under it, and the daily budgets card. */
function costHtml(p: Panel): { strip: string; budgets: string } {
  const k = p.cost;
  const budgets = card("h-bud", "Budgets", budgetsHtml(p) || `<p class="emp">No budget data</p>`, {
    aside: "Daily, UTC",
    link: (p.budgets ?? []).some((b) => b.pct >= 0.8) ? go(tabHref("setup"), "Raise") : "",
  });
  if (!k)
    return {
      strip: card("h-cost", "Cost", `<p class="emp">Cost data is updating. Reload in a minute.</p>`),
      budgets,
    };
  const perWake = k.wakes24 ? k.spend24Usd / k.wakes24 : 0;
  const cell = (label: string, big: string, small: string) =>
    `<div class="cell"><span class="k">${label}</span><span class="big">${big}</span><small>${esc(small)}</small></div>`;
  const strip = `<div class="strip">${cell("Projected month", usd(k.monthUsd), "30 days at the last 24 h pace")}${cell(
    "Always-on month",
    usd(k.alwaysOnMonthUsd),
    "Same instance, never asleep",
  )}${cell("Saved", `${k.savedPct}%`, "Under always-on")}${cell("Last 24 h", usd(k.spend24Usd), `${plural(k.wakes24, "wake")}, ${usd(perWake)} each`)}</div>`;
  const guard = `<div class="bd line">${
    k.holding
      ? stat("WARN", "Cost guard is holding the install awake")
      : stat("PASS", "Cost guard not holding")
  }<span class="k"> Keeps the install awake when waking and sleeping would cost more than staying up.</span>${
    k.holding ? `<span class="fixr">Fix: <code>ochost sleep status</code></span>` : ""
  }</div>`;
  return {
    strip: card("h-cost", "Cost", `${strip}${guard}`, { aside: "Duty-cycle, sleeps when idle" }),
    budgets,
  };
}

/**
 * Overview, below the state card (which already says if it is on, the top alert's fix, and the cost): Cost (the
 * month strip, the cost guard line), Alerts (a summary box that links to the Alerts and log tab), Budgets (daily
 * caps, Raise when one is at 80 %), then the Connected and Backups tables.
 */
function overviewTab(p: Panel): string {
  const open = p.alerts.open;
  const high = open.filter((a) => a.severity === "high").length;
  const newest = open[0] ?? null;
  const alertsBox = `<div class="bd"><p class="sw2">${open.length ? `${plural(open.length, "open alert")}${high ? `, ${high} high` : ""}` : "No open alerts"}</p><p class="k">${
    newest
      ? `Newest: ${esc(newest.class)}, ${ago(p.now, newest.at)}`
      : `${plural((p.alerts.closed ?? []).length, "closed alert")} in 30 days`
  }</p></div>`;
  const alertsCard = card("h-al", "Alerts", alertsBox, {
    link: go(tabHref("log"), open.length ? "Open alerts" : "All alerts"),
  });
  const cost = costHtml(p);
  return `<div class="g2"><div>${cost.strip}${healthHtml(p)}</div><div>${alertsCard}${cost.budgets}</div></div>`;
}

function panelPage(
  nonce: string,
  v: OwnerView,
  note: string,
  p: Panel,
  fast: boolean,
  power: string,
  st: { last: string; next: { main: string; sub: string } },
  q: { tab?: string | null; kind?: string | null },
): string {
  const k = p.cost ?? { monthUsd: Number.NaN, alwaysOnMonthUsd: Number.NaN };
  const meta = `<dl class="meta"><div><dt>Last activity</dt><dd>${esc(st.last)}</dd></div>
<div><dt>Next wake</dt><dd>${esc(st.next.main)}${st.next.sub ? `<small>${esc(st.next.sub)}</small>` : ""}</dd></div>
<div><dt>Projected month</dt><dd>${Number.isNaN(k.monthUsd) ? "updating" : usd(k.monthUsd)}${Number.isNaN(k.alwaysOnMonthUsd) ? "" : `<small>always-on ${usd(k.alwaysOnMonthUsd)}</small>`}</dd></div>
<div><dt>Checks</dt><dd>${p.fails || p.warns ? `${p.fails} failing` : "All pass"}${p.warns ? `<small>${plural(p.warns, "warning")}</small>` : ""}</dd></div></dl>`;
  const tab: Tab = TABS.find(([t]) => t === q.tab)?.[0] ?? OLD_TABS[q.tab ?? ""] ?? "overview";
  const kind = tab === "log" && KINDS.some(([x]) => x === q.kind) ? (q.kind as string) : null;
  const rows = setupRows(p);
  const count: Partial<Record<Tab, [number, boolean]>> = {
    setup: [rows.filter((r) => r.todo).length, false],
    log: [p.alerts.open.length, p.alerts.open.some((a) => a.severity === "high")],
  };
  const nav = `<nav class="tabs" aria-label="Sections">${TABS.map(([t, label]) => {
    const c = count[t];
    return `<a href="${tabHref(t)}"${t === tab ? ' aria-current="page"' : ""}>${label}${
      c?.[0]
        ? `<span class="n${c[1] ? " hot" : ""}">${c[0]}<span class="vh"> ${t === "setup" ? "to do" : "open"}</span></span>`
        : ""
    }</a>`;
  }).join("")}</nav>`;
  const body = tab === "setup" ? setupTab(rows) : tab === "log" ? logTab(p, kind) : overviewTab(p);
  const here = tabHref(tab, kind ? `&kind=${kind}` : "");
  return consolePage(
    nonce,
    v.inst,
    note,
    `${heroHtml(v, meta, power)}${nav}<div class="tp" id="tab-${tab}">${body}</div>`,
    `setTimeout(function(){location.replace(${JSON.stringify(here)})},${fast ? 5000 : 30000});`,
  );
}
