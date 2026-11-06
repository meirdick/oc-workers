// D2 (M5B-STATUS): the sleep check's channel classification. The gateway stays up only for a running
// channel that needs a socket; channels-unknown only when the channels.status check itself failed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { channelBlockers, channelsFromCli, createSleepOps } from "../lib/sleep.mjs";

// channels.status reply shape as read on oc-demo 2026-11-01 (2026.10.9), token fields left out.
const tg = (o = {}) => ({
  accountId: "default",
  enabled: true,
  configured: true,
  running: true,
  connected: true,
  lifecycle: "ready",
  restartPending: false,
  reconnectAttempts: 0,
  mode: "webhook",
  lastError: null,
  ...o,
});
const reply = (channelAccounts) =>
  JSON.stringify(
    { ts: 1, channelOrder: Object.keys(channelAccounts), channels: {}, channelAccounts },
    null,
    2,
  );

/** Run sleep-check with only the channel dep varied; every other dep reports idle. */
async function check(channelsStatus) {
  const logs = [];
  const events = [];
  const S = createSleepOps({
    draining: () => false,
    queryRows: async () => ({ nextWakeAtMs: null }),
    channelsStatus,
    gateway: { running: () => true },
    log: (ev, f) => logs.push([ev, f]),
    event: (k, x) => events.push([k, x]),
  });
  const r = await S.handle("sleep-check", "op1");
  return { r, logs, events };
}

test("no channel configured: empty channelAccounts -> sleepable", async () => {
  const acc = channelsFromCli({ code: 0, out: reply({}) });
  assert.deepEqual(acc, []);
  assert.deepEqual(channelBlockers(acc), []);
  const { r, events } = await check(async () => acc);
  assert.deepEqual(r.blockers, []);
  assert.equal(events.length, 0);
});

test("webhook-only Telegram (oc-demo shape) -> sleepable", async () => {
  // stderr noise with a brace before the JSON must not hide the reply
  const out = `[plugins] warn {cache} cold\n${reply({ telegram: [tg()] })}`;
  const acc = channelsFromCli({ code: 0, out });
  assert.equal(acc.length, 1);
  assert.equal(acc[0].transport, "webhook");
  assert.deepEqual(channelBlockers(acc), []);
  const { r } = await check(async () => acc);
  assert.deepEqual(r.blockers, []);
});

test("running socket channel -> channel-socket blocker named", async () => {
  const acc = channelsFromCli({
    code: 0,
    out: reply({
      telegram: [tg({ mode: "polling" })],
      discord: [tg({ mode: undefined })],
      slack: [tg({ running: false, mode: "socket" })],
    }),
  });
  const b = channelBlockers(acc);
  assert.deepEqual(
    b.map((x) => [x.kind, x.detail]),
    [
      ["channel-socket", "telegram:default transport polling"],
      ["channel-socket", "discord:default transport unknown"],
    ],
  );
  const { r } = await check(async () => acc);
  assert.equal(r.blockers[0].kind, "channel-socket");
  assert.match(r.blockers[0].detail, /^telegram:default/);
});

test("check failed (RPC error, timeout) -> channels-unknown with the error text", async () => {
  assert.throws(
    () => channelsFromCli({ code: 1, out: "Gateway call failed: Error: gateway timeout after 15000ms" }),
    /channels\.status exit 1: Gateway call failed: Error: gateway timeout after 15000ms/,
  );
  assert.throws(
    () => channelsFromCli({ code: null, signal: "SIGKILL", out: "" }),
    /exit \? SIGKILL: no output/,
  );
  assert.throws(() => channelsFromCli({ code: 0, out: '{"ok":true}' }), /reply without channelAccounts/);
  const { r, logs, events } = await check(async () =>
    channelsFromCli({ code: 1, out: "Gateway call failed: Error: gateway timeout after 15000ms" }),
  );
  assert.equal(r.blockers.length, 1);
  assert.equal(r.blockers[0].kind, "channels-unknown");
  assert.match(r.blockers[0].detail, /gateway timeout after 15000ms/);
  assert.equal(events[0][0], "sleep-check-channels");
  assert.match(events[0][1].detail.error, /gateway timeout/);
  assert.ok(logs.some(([ev]) => ev === "sleep-check-channels"));
});

test("Slack HTTP and SMS accounts are webhook (sleepable); Slack socket, relay and Discord stay socket", async () => {
  // mode as the channel plugins report it in channels.status: slack mode http|socket|relay, sms no mode at all
  const acc = channelsFromCli({
    code: 0,
    out: reply({
      slack: [tg({ mode: "http" })],
      sms: [tg({ mode: undefined })],
      discord: [tg({ mode: "interactions" })],
    }),
  });
  assert.deepEqual(
    acc.map((a) => [a.channel, a.transport]),
    [
      ["slack", "webhook"],
      ["sms", "webhook"],
      ["discord", "webhook"],
    ],
  );
  assert.deepEqual(channelBlockers(acc), []);
  const { r } = await check(async () => acc);
  assert.deepEqual(r.blockers, []);

  const hard = channelsFromCli({
    code: 0,
    out: reply({
      slack: [tg({ mode: "socket" }), tg({ accountId: "relay", mode: "relay" })],
      discord: [tg({ mode: undefined })],
      telegram: [tg({ mode: "polling" })],
      sms: [tg({ mode: "polling" })], // an explicit non-webhook mode still counts
    }),
  });
  assert.deepEqual(
    channelBlockers(hard).map((b) => b.detail),
    [
      "slack:default transport socket",
      "slack:relay transport relay",
      "discord:default transport unknown",
      "telegram:default transport polling",
      "sms:default transport polling",
    ],
  );
});
