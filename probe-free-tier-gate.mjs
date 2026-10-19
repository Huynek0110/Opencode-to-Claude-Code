#!/usr/bin/env node
/**
 * Settle the one claim in this repository that is load-bearing and currently
 * unreproduced: does a `permissions: deny` rule make the free tier refuse?
 *
 * Why it is load-bearing. README, opencode-config/opencode.json and the bridge
 * comments all state it as measured fact, and the argument that "deny rules are
 * not load-bearing, safety is structural" rests on it. Round 9 re-ran the
 * session-create matrix and got 200 on all six variants, which contradicts the
 * original reading. Either the check moved to inference time, or the original
 * 503 was a rate limit misread as a configuration failure.
 *
 * Session create cannot distinguish those two. Only inference can.
 *
 * COST: four /generate calls with a two-character prompt. On the measured
 * prompt shape that is roughly 1 000 tokens each, so about 4 000 total.
 *
 * DO NOT RUN without quota. See AGENTS.md.
 *
 *   node probe-free-tier-gate.mjs
 *
 * It reports, it does not assert. A free tier's behaviour changes by the hour,
 * and a red suite that really means "rate limited" teaches you to ignore red.
 */
import { readFileSync } from "node:fs";

// bridge.mjs uses OC_BASE = http://127.0.0.1:4599/api and then passes paths
// like "/session". Getting this wrong silently produces a 404 that looks like
// the gate refusing, which would be a false reading of the one thing this
// probe exists to measure.
const OC = (process.env.OPENCODE_URL || "http://127.0.0.1:4599") + "/api";
const pass = readFileSync(".opencode-password", "utf8").trim();
const auth = "Basic " + Buffer.from("opencode:" + pass).toString("base64");

const VARIANTS = [
  { key: "plain", body: { title: "gate-plain" } },
  { key: "deny-inline", body: { title: "gate-deny", permissions: [{ action: "*", resource: "*", effect: "deny" }] } },
  { key: "allow-inline", body: { title: "gate-allow", permissions: [{ action: "*", resource: "*", effect: "allow" }] } },
  { key: "agent-explore", body: { title: "gate-explore", agent: "explore" } },
];

async function jfetch(path, init) {
  const r = await fetch(OC + path, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: auth, ...(init?.headers || {}) },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const created = [];

async function main() {
  console.log("One session per variant, then ask each for the shortest possible reply.\n");
  console.log("variant         create  generate  verdict");
  console.log("-".repeat(58));

  for (const v of VARIANTS) {
    const c = await jfetch("/session", { method: "POST", body: JSON.stringify(v.body) });
    const id = c.body?.data?.id || c.body?.id;
    if (id) created.push(id);

    if (c.status !== 200 || !id) {
      console.log(v.key.padEnd(15) + String(c.status).padEnd(7) + "-".padEnd(9) + "create refused");
      continue;
    }

    // Exactly what bridge.mjs sends, and no more. /generate declares
    // additionalProperties: false, so adding a `model` key here would be
    // rejected by the schema rather than by the gate we are trying to test.
    const g = await jfetch("/session/" + id + "/generate", {
      method: "POST",
      body: JSON.stringify({ prompt: "hi" }),
    });

    let verdict;
    if (g.status === 200) verdict = "served";
    else if (g.status === 503) verdict = "REFUSED by free tier";
    else if (g.status === 429) verdict = "rate limited (inconclusive)";
    else verdict = "other " + g.status + ": " + JSON.stringify(g.body).slice(0, 90);

    console.log(v.key.padEnd(15) + String(c.status).padEnd(7) + String(g.status).padEnd(9) + verdict);
  }

  console.log("\nReading it:");
  console.log("  served everywhere    -> the original 503 was a rate limit misread as a config");
  console.log("                          failure. The safety argument must be rewritten, not kept.");
  console.log("  refused only on deny -> the original reading was right, and it holds at");
  console.log("                          inference time rather than at session-create time.");
  console.log("  429 anywhere        -> inconclusive. Stop, and try later. Do not conclude.");
}

main()
  .catch((e) => console.error("probe failed:", e.message))
  .finally(async () => {
    for (const id of created) await jfetch("/session/" + id, { method: "DELETE" }).catch(() => {});
    console.log("\ncleaned up " + created.length + " session(s)");
  });
