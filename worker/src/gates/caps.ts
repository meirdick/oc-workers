// Capability budgets (docs/11 §4): per-verb daily counters in the Control DO, UTC day. Alert at 80%, refuse at 100%.
// Verbs: browser (seconds of browser time), neurons (Workers AI, estimated), requests (every CapGate call),
// websearch (successful web searches; Web Search API bills per request), exec (seconds of sandbox commands,
// SandboxGate), sandbox (hours the sandbox container runs; docs/12 §6).
// Storage is the Control DO SQLite (tables below, created by GateLedger.migrate); logic is pure SQL + math.
import type { Severity } from "../core/types";

export const VERBS = ["browser", "neurons", "requests", "websearch", "exec", "sandbox"] as const;
export type CapVerb = (typeof VERBS)[number];

/**
 * Daily defaults. neurons = about $1.1 a day of Workers AI (the model hop runs through the gate; the 10k free
 * tier lasts a few turns); browser = 1 h; requests = a busy agent day; websearch = 200 searches; exec = 2 h of
 * command time; sandbox = 8 h of container (basic: ~$0.01/h, so ~$0.08/day at the cap).
 */
export const CAP_DEFAULTS: Readonly<Record<CapVerb, number>> = Object.freeze({
  browser: 3600,
  neurons: 100_000,
  requests: 2000,
  websearch: 200,
  exec: 7200,
  sandbox: 8,
});
export const CAP_ALERT_AT = 0.8;
/** The highest daily limit `POST /ops/caps` takes (and the panel's Raise sets). */
export const CAP_MAX = 1e9;

export const CAP_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cap_day (day TEXT NOT NULL, verb TEXT NOT NULL, used REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (day, verb))`,
  `CREATE TABLE IF NOT EXISTS cap_limit (verb TEXT PRIMARY KEY, lim REAL NOT NULL)`,
];

export interface CapUse {
  verb: CapVerb;
  used: number;
  limit: number;
  /** used / limit; 1 when the limit is 0. */
  pct: number;
}
export interface CapTake extends CapUse {
  ok: boolean;
  /** Seconds to the next UTC midnight (when a refusal clears unless the owner raises the limit). */
  retryAfterS: number;
}
export interface CapsView {
  day: string;
  resetsInS: number;
  verbs: Record<CapVerb, CapUse>;
}

export const isVerb = (v: unknown): v is CapVerb => (VERBS as readonly unknown[]).includes(v);

type Bind = string | number | null;
interface Store {
  sql: { exec(query: string, ...bindings: Bind[]): { toArray(): unknown[] } };
  transactionSync<T>(fn: () => T): T;
}

const DAY_MS = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const retryAfter = (ms: number) => Math.max(1, Math.ceil((DAY_MS - (ms % DAY_MS)) / 1000));

export class Caps {
  constructor(
    private readonly store: Store,
    private readonly now: () => number,
    private readonly alert: (cls: string, severity: Severity, detail: string) => void,
  ) {}

  private one<T>(q: string, ...b: Bind[]): T | null {
    return (this.store.sql.exec(q, ...b).toArray()[0] as T | undefined) ?? null;
  }
  private run(q: string, ...b: Bind[]) {
    this.store.sql.exec(q, ...b).toArray();
  }

  limit(verb: CapVerb): number {
    return (
      this.one<{ lim: number }>("SELECT lim FROM cap_limit WHERE verb = ?", verb)?.lim ?? CAP_DEFAULTS[verb]
    );
  }
  private usedOn(day: string, verb: CapVerb): number {
    return (
      this.one<{ used: number }>("SELECT used FROM cap_day WHERE day = ? AND verb = ?", day, verb)?.used ?? 0
    );
  }
  private use(verb: CapVerb, used: number): CapUse {
    const limit = this.limit(verb);
    return { verb, used, limit, pct: limit > 0 ? used / limit : 1 };
  }

  /** Is there room? Does not charge. */
  check(verb: CapVerb): CapTake {
    const t = this.now();
    const u = this.use(verb, this.usedOn(dayOf(t), verb));
    return { ...u, ok: u.used < u.limit, retryAfterS: retryAfter(t) };
  }

  /** Charge `n` (>= 0) to today. The call that crosses 80% or 100% raises the alert. A charge never refuses. */
  add(verb: CapVerb, n: number): CapUse {
    const amount = Number.isFinite(n) && n > 0 ? n : 0;
    return this.store.transactionSync(() => {
      const day = dayOf(this.now());
      const before = this.usedOn(day, verb);
      const after = before + amount;
      if (amount > 0)
        this.run(
          `INSERT INTO cap_day (day, verb, used) VALUES (?, ?, ?)
           ON CONFLICT(day, verb) DO UPDATE SET used = excluded.used`,
          day,
          verb,
          after,
        );
      const u = this.use(verb, after);
      const was = this.use(verb, before);
      if (u.limit > 0 && was.pct < 1 && u.pct >= 1)
        this.alert(`cap-${verb}-100`, "high", `${verb} ${Math.round(after)}/${u.limit} today; calls get 429`);
      else if (u.limit > 0 && was.pct < CAP_ALERT_AT && u.pct >= CAP_ALERT_AT)
        this.alert(`cap-${verb}-80`, "warn", `${verb} ${Math.round(after)}/${u.limit} today`);
      return u;
    });
  }

  /** Check, then charge `n` when there is room. Refused → nothing charged. */
  take(verb: CapVerb, n: number): CapTake {
    const c = this.check(verb);
    if (!c.ok) return c;
    return { ...this.add(verb, n), ok: true, retryAfterS: c.retryAfterS };
  }

  view(): CapsView {
    const t = this.now();
    const day = dayOf(t);
    const verbs = {} as Record<CapVerb, CapUse>;
    for (const v of VERBS) verbs[v] = this.use(v, this.usedOn(day, v));
    return { day, resetsInS: retryAfter(t), verbs };
  }

  /** Set daily limits (raise or lower). A verb not in `l` is unchanged. Throws on a bad value. */
  setLimits(l: Partial<Record<CapVerb, unknown>>): CapsView {
    const next: [CapVerb, number][] = [];
    for (const v of VERBS) {
      if (l[v] === undefined) continue;
      const n = Number(l[v]);
      if (!Number.isFinite(n) || n < 0 || n > CAP_MAX) throw new Error(`bad limit for ${v}`);
      next.push([v, n]);
    }
    this.store.transactionSync(() => {
      for (const [v, n] of next)
        this.run(
          "INSERT INTO cap_limit (verb, lim) VALUES (?, ?) ON CONFLICT(verb) DO UPDATE SET lim = excluded.lim",
          v,
          n,
        );
    });
    return this.view();
  }
}

// ---------- neuron estimates ----------
// guess: Workers AI bills neurons, the OpenAI-compatible reply does not say how many. These are conversions from the
// price page (CF workers-ai/platform/pricing: $0.011 per 1k neurons; bge-m3 $0.012/M tokens; melotts $0.0002/min;
// whisper $0.0005/min; image: flat guess). The AI Gateway spend limit stays the hard backstop.
const NEURONS_PER_USD = 1000 / 0.011;
export const NEURONS = Object.freeze({
  embeddingPerToken: (0.012 / 1e6) * NEURONS_PER_USD,
  ttsPerChar: ((0.0002 / 60) * NEURONS_PER_USD) / 15, // guess: 15 chars per second of speech
  sttPerSecond: (0.0005 / 60) * NEURONS_PER_USD,
  imageEach: 500, // guess
  // guess, used only when the model reports no neurons: Workers AI list prices run 0.01-0.03 neurons per prompt
  // token (gemma-4 26B, gpt-oss, deepseek cold; docs/09 M5b), completion about 3x that.
  chatPerPromptToken: 0.03,
  chatPerCompletionToken: 0.1,
  fallback: 10,
});

/** Neurons for one finished /ai/v1 call. `route` is the path after /ai/v1/. `body` is the parsed JSON reply. */
export function estimateNeurons(
  route: string,
  req: { bytes: number; json?: Record<string, unknown> | null },
  body: Record<string, unknown> | null,
): number {
  const usage = (body?.usage ?? null) as {
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
  const tokens = Number(usage?.total_tokens ?? usage?.prompt_tokens ?? 0);
  if (route.startsWith("embeddings")) {
    const t = tokens || Math.ceil(req.bytes / 4);
    return Math.ceil(t * NEURONS.embeddingPerToken);
  }
  if (route.startsWith("audio/speech")) {
    const chars = String(req.json?.input ?? "").length || req.bytes;
    return Math.ceil(chars * NEURONS.ttsPerChar);
  }
  if (route.startsWith("audio/")) {
    // guess: 16 kB per second of compressed audio
    return Math.ceil((req.bytes / 16_000) * NEURONS.sttPerSecond);
  }
  if (route.startsWith("images/")) {
    const n = Number(req.json?.n ?? 1);
    return Math.ceil((Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 1) * NEURONS.imageEach);
  }
  if (route.startsWith("chat/") || route.startsWith("responses")) {
    const n =
      Number(usage?.prompt_tokens ?? 0) * NEURONS.chatPerPromptToken +
      Number(usage?.completion_tokens ?? 0) * NEURONS.chatPerCompletionToken;
    return Math.ceil(n || tokens * NEURONS.chatPerPromptToken) || NEURONS.fallback;
  }
  return NEURONS.fallback;
}
