// Inbox adapter interface (add §2.2, §3). An adapter verifies one platform's webhook, tells the Worker what to
// answer inside the platform's ack deadline, and says how a stored row is replayed to the gateway's own route.
// The Worker stores the row in the Control DO first and acks; the container never has to be up.

/** Secret values the adapters read: env name → value. Worker secrets, never logged. */
export type PlatformSecrets = Record<string, string | undefined>;

export interface AdapterResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface InboundReq {
  method: string;
  /** Full public URL as Cloudflare saw it (Twilio signs it). */
  url: string;
  headers: { get(name: string): string | null };
  body: string;
  now: number;
}

export type Verdict =
  /** Answered here, nothing stored: bad signature, URL challenge, PING, ignorable event. */
  | { kind: "respond"; res: AdapterResponse; seen?: "challenge" | "ping" }
  /** Authentic and worth delivering: store, ack, wake. */
  | {
      kind: "store";
      /** Platform dedupe key. Unique per (route, account); a retry of the same event maps to the same row. */
      platformKey: string;
      senderId: string | null;
      chatId: string | null;
      /** Headers kept on the row for the replay (never a secret). */
      headers: Record<string, string>;
      ack: AdapterResponse;
      /** True: do not wake an asleep install for this row (it replays at the next wake). */
      hold?: boolean;
    };

export interface InboxAdapter {
  id: "slack" | "discord" | "twilio";
  /** OpenClaw channel id in config (`channels.<channel>`); Twilio is "sms". */
  channel: string;
  /** Inbox route, also the gateway's own HTTP path the row is replayed to. */
  route: string;
  /** Public Worker path the platform console points at. */
  hookPath: string;
  /** The platform's ack deadline. Our ack is one DO write, far inside it. */
  ackDeadlineMs: number;
  /** Does the gateway's route set `x-openclaw-delivery-accepted: durable`? false: a plain 2xx is the accept. */
  durableHeader: boolean;
  /** Worker secret names the adapter needs (OC_SECRET_<NAME> is the gateway's env NAME). */
  secrets: readonly string[];
  receive(r: InboundReq, s: PlatformSecrets): Promise<Verdict>;
  /** Headers for the replay POST. Fresh signatures where the platform's check has a time window. */
  replayHeaders(
    row: { headers: Record<string, string>; body: string },
    s: PlatformSecrets,
    now: number,
  ): Promise<Record<string, string>>;
}
