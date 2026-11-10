// The console's in-place refresh (ui/pages.ts REFRESH_JS) and the waking page script, run in Node against small
// fakes: the repo has no DOM library. The fake parses only what REFRESH_JS reads: `<main id="oc">` and its regions.
import { describe, expect, it } from "vitest";
import type { OwnerView } from "../../src/core/types";
import { REFRESH_JS, statusPage, wakingPage } from "../../src/ui/pages";

const NOW = Date.now();
const view = (state: string): OwnerView => ({
  inst: "oc-t",
  state,
  stateAt: NOW - 60_000,
  lastActivityAt: null,
  nextWakeAt: null,
  snapshots: 1,
  alerts: [],
  now: NOW,
});

interface El {
  id: string;
  tagName: string;
  html: string;
  attrs: Map<string, string>;
  form?: unknown;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  setAttribute(k: string, v: string): void;
  replaceWith(n: El): void;
}

const el = (tag: string, attrs: string, html = ""): El => {
  const a = new Map<string, string>();
  for (const m of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g))
    a.set(m[1] as string, (m[2] ?? "").replace(/&amp;/g, "&"));
  return {
    id: a.get("id") ?? "",
    tagName: tag.toUpperCase(),
    html,
    attrs: a,
    getAttribute: (k) => a.get(k) ?? null,
    hasAttribute: (k) => a.has(k),
    setAttribute: (k, v) => void a.set(k, v),
    replaceWith() {},
  };
};

/** A parsed page: #oc and its swap regions (the markup has `data-sw` on top-level children of #oc only). */
function parse(html: string) {
  const main = /<main ([^>]*)>/.exec(html);
  const oc = main && /id="oc"/.test(main[1] as string) ? el("main", main[1] as string) : null;
  const regs = [...html.matchAll(/<(\w+) ([^>]*id="[\w-]+" data-sw[^>]*)>/g)].map((m) => {
    const start = (m.index ?? 0) + m[0].length;
    return el(m[1] as string, m[2] as string, html.slice(start, start + 200));
  });
  return {
    getElementById: (id: string) => (id === "oc" ? oc : (regs.find((r) => r.id === id) ?? null)),
    querySelectorAll: (q: string) => (q === "#oc>[data-sw]" && oc ? regs : []),
  };
}

type Answer = { status: number; body?: string; redirected?: boolean } | "neterr";

/** Runs REFRESH_JS on `page`. `answers` are what each fetch gets, in turn. */
function run(page: string, answers: Answer[], href = "/") {
  const cur = parse(page);
  const timers: { fn: () => void; ms: number }[] = [];
  const fetches: { url: string; init: RequestInit }[] = [];
  const replaced: string[] = [];
  const swaps: [string, string][] = [];
  const hist: string[] = [];
  const scrolls: [number, number][] = [];
  const on: Record<string, (e?: unknown) => void> = {};
  const listen = (k: string, f: () => void) => {
    on[k] = f;
  };
  const [path, query = ""] = href.split("?");
  for (const r of cur.querySelectorAll("#oc>[data-sw]"))
    r.replaceWith = (n) => {
      swaps.push([r.id, n.html]);
      r.html = n.html;
    };
  const doc = {
    ...cur,
    visibilityState: "visible",
    activeElement: null as unknown,
    forms: [] as { elements: unknown[] }[],
    importNode: (n: El) => n,
    addEventListener: listen,
  };
  const win = {
    scrollX: 3,
    scrollY: 900,
    scrollTo: (x: number, y: number) => void scrolls.push([x, y]),
    addEventListener: listen,
  };
  const loc = {
    pathname: path,
    search: query ? `?${query}` : "",
    hash: "",
    replace: (u: string) => void replaced.push(u),
  };
  const fetch = (url: string, init: RequestInit) => {
    fetches.push({ url, init });
    const a = answers.shift() ?? "neterr";
    if (a === "neterr") return Promise.reject(new TypeError("offline"));
    return Promise.resolve({
      status: a.status,
      redirected: !!a.redirected,
      text: () => Promise.resolve(a.body ?? ""),
    });
  };
  class DOMParser {
    parseFromString(t: string) {
      return parse(t);
    }
  }
  new Function("document", "window", "location", "history", "fetch", "DOMParser", "setTimeout", REFRESH_JS)(
    doc,
    win,
    loc,
    {
      replaceState: (_s: unknown, _t: string, u: string) => {
        hist.push(u);
        const [p, q = ""] = u.split("?");
        loc.pathname = p as string;
        loc.search = q ? `?${q}` : "";
      },
    },
    fetch,
    DOMParser,
    (fn: () => void, ms: number) => timers.push({ fn, ms }),
  );
  /** Fire the next timer and let the fetch chain settle. */
  const tick = async () => {
    const t = timers.shift();
    if (!t) throw new Error("no timer set");
    t.fn();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { timers, fetches, replaced, swaps, hist, scrolls, doc, on, tick };
}

const starting = statusPage("n1", view("starting"));
const waitingCap = statusPage("n2", view("waiting-capacity"));

describe("console refresh in place (REFRESH_JS)", () => {
  it("swaps each region by id, keeps the scroll, takes the next cadence from the new page", async () => {
    const r = run(statusPage("n0", view("quiescing")), [
      { status: 200, body: statusPage("n9", view("stopping")) },
    ]);
    expect(r.timers.map((t) => t.ms)).toEqual([5000]);
    await r.tick();
    expect(r.fetches).toHaveLength(1);
    expect(r.fetches[0]?.url).toBe("/");
    expect(r.fetches[0]?.init).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
      headers: { accept: "text/html" },
    });
    expect(r.swaps.map(([id]) => id)).toEqual(["nt", "hero"]);
    expect(r.swaps[1]?.[1]).toContain("Stopping");
    expect(r.scrolls).toEqual([[3, 900]]);
    expect(r.replaced).toEqual([]);
    expect(r.timers.map((t) => t.ms)).toEqual([5000]);
  });

  it("stops when the new page has no cadence (the plain page once the state stops moving)", async () => {
    const r = run(starting, [{ status: 200, body: statusPage("n5", view("asleep")) }]);
    await r.tick();
    expect(r.swaps.map(([id]) => id)).toEqual(["nt", "hero"]);
    expect(r.timers).toEqual([]);
  });

  it("the one-time notice leaves the address bar after the first swap", async () => {
    const r = run(
      statusPage("n0", view("asleep"), { code: "wake" }),
      [{ status: 200, body: starting }],
      "/?n=wake",
    );
    await r.tick();
    expect(r.hist).toEqual(["/"]);
    expect(r.swaps.map(([id, h]) => [id, h.includes("Wake requested")])).toEqual([
      ["nt", false],
      ["hero", false],
    ]);
  });

  it("a wake that reaches running reloads once, as before", async () => {
    const r = run(starting, [
      { status: 200, body: waitingCap },
      { status: 200, body: statusPage("n3", view("running")) },
    ]);
    await r.tick();
    expect(r.replaced).toEqual([]);
    await r.tick();
    expect(r.replaced).toEqual(["/"]);
    expect(r.timers).toEqual([]);
  });

  it("falls back to one full reload: redirect, non-200, login page, other regions", async () => {
    const login = '<!doctype html><html><body><main class="card"><h1>Sign in</h1></main></body></html>';
    const other = starting.replace(
      '<div id="nt" data-sw>',
      '<div id="nt" data-sw></div><div id="x" data-sw>',
    );
    for (const a of [
      { status: 0 },
      { status: 200, redirected: true, body: starting },
      { status: 503 },
      { status: 200, body: login },
      { status: 200, body: other },
    ]) {
      const r = run(starting, [a]);
      await r.tick();
      expect(r.replaced).toEqual(["/"]);
      expect(r.swaps).toEqual([]);
      expect(r.timers).toEqual([]);
    }
  });

  it("a network error or a status-not-available page keeps this page and tries again", async () => {
    for (const a of ["neterr", { status: 200, body: statusPage("n4", null) }] as Answer[]) {
      const r = run(starting, [a]);
      await r.tick();
      expect(r.replaced).toEqual([]);
      expect(r.swaps).toEqual([]);
      expect(r.timers.map((t) => t.ms)).toEqual([5000]);
    }
  });

  it("skips while hidden, and runs when the page shows again", async () => {
    const r = run(starting, [{ status: 200, body: waitingCap }]);
    r.doc.visibilityState = "hidden";
    await r.tick();
    expect(r.fetches).toEqual([]);
    expect(r.timers).toEqual([]);
    r.doc.visibilityState = "visible";
    r.on.visibilitychange?.();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(r.fetches).toHaveLength(1);
    expect(r.swaps.map(([id]) => id)).toEqual(["nt", "hero"]);
  });

  it("skips while a form field has focus or unsaved edits, or after a submit", async () => {
    const focus = run(starting, []);
    focus.doc.activeElement = { tagName: "INPUT", form: {} };
    await focus.tick();
    expect(focus.fetches).toEqual([]);
    expect(focus.timers.map((t) => t.ms)).toEqual([5000]);

    const typed = run(starting, []);
    typed.doc.forms = [{ elements: [{ type: "url", value: "https://ntfy.sh/x", defaultValue: "" }] }];
    await typed.tick();
    expect(typed.fetches).toEqual([]);

    const picked = run(starting, []);
    picked.doc.forms = [{ elements: [{ options: [{ selected: true, defaultSelected: false }] }] }];
    await picked.tick();
    expect(picked.fetches).toEqual([]);

    const clean = run(starting, [{ status: 200, body: waitingCap }]);
    clean.doc.forms = [{ elements: [{ type: "hidden", value: "a", defaultValue: "a" }, { type: "submit" }] }];
    await clean.tick();
    expect(clean.fetches).toHaveLength(1);

    const sent = run(starting, []);
    sent.on.submit?.();
    await sent.tick();
    expect(sent.fetches).toEqual([]);
    expect(sent.timers).toEqual([]);
  });
});

/** Runs the waking page script. `states`: what each wake-status poll answers. `stored`: sessionStorage. */
function waking(states: string[], stored: Record<string, string> = {}) {
  const js = /<script nonce="w">([\s\S]*)<\/script>/.exec(wakingPage("w"))?.[1] ?? "";
  let now = 1_000_000;
  const timers: { fn: () => void; at: number }[] = [];
  const replaced: string[] = [];
  const store = { ...stored };
  new Function("document", "location", "fetch", "sessionStorage", "setTimeout", "setInterval", "Date", js)(
    { getElementById: () => ({ textContent: "" }) },
    { pathname: "/chat", search: "", hash: "", replace: (u: string) => void replaced.push(u) },
    () => {
      const st = states.shift() ?? "running";
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ state: st, started: st === "running" }),
      });
    },
    {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    },
    (fn: () => void, ms: number) => timers.push({ fn, at: now + ms }),
    () => 0,
    { now: () => now },
  );
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  /** Move the clock to the next poll and run it. */
  const poll = async () => {
    const t = timers.shift();
    if (!t) throw new Error("no poll set");
    now = Math.max(now, t.at);
    t.fn();
    await settle();
  };
  return { replaced, store, poll, settle, elapsed: () => now - 1_000_000 };
}

describe("waking page: one reload when started, no reload loop", () => {
  it("started after a not-started poll: reloads at once", async () => {
    const w = waking(["asleep", "starting", "running"]);
    await w.settle();
    await w.poll();
    expect(w.replaced).toEqual([]);
    await w.poll();
    expect(w.replaced).toEqual(["/chat"]);
    expect(JSON.parse(w.store.ocwake ?? "{}").n).toBe(1);
  });

  it("started on the first poll (the reload got this page again): waits 5 s on the page", async () => {
    const w = waking(["running"]);
    await w.settle();
    expect(w.replaced).toEqual([]);
    while (!w.replaced.length) await w.poll();
    expect(w.elapsed()).toBe(5000);
  });

  it("after recent reloads the wait grows, at most 30 s; a record over 60 s old does not count", async () => {
    for (const [n, ms] of [
      [2, 8000],
      [9, 30000],
    ]) {
      const w = waking(["running"], { ocwake: JSON.stringify({ n, t: 1_000_000 - 1000 }) });
      await w.settle();
      while (!w.replaced.length) await w.poll();
      expect(w.elapsed()).toBe(ms);
    }
    const w = waking(["starting", "running"], { ocwake: JSON.stringify({ n: 5, t: 1_000_000 - 61_000 }) });
    await w.settle();
    await w.poll();
    expect(w.replaced).toEqual(["/chat"]);
  });
});
