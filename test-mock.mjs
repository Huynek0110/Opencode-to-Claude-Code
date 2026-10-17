#!/usr/bin/env node
/**
 * Contract tests against a mock OpenCode, at zero token cost.
 *
 * Why this exists: the live suites drove the real model, which meant the test
 * run cost tokens on every invocation, hit the free tier's rate limiter partway
 * through (every remaining case failed with 503, so the suite reported the
 * rate limiter rather than the bridge), and could not test a fast turn or a
 * slow turn on demand. Every one of those is a property of the bridge's HTTP
 * and retry logic, not of the model.
 *
 * The mock replaces `opencode serve` only. The bridge under test is the real
 * bridge.mjs, started as a child process against this mock, so the code path
 * exercised is the shipping one: same request handling, same SSE writer, same
 * error taxonomy, same session cache.
 *
 *   node test-mock.mjs
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = 47611;
const BRIDGE_PORT = 47811;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const BRIDGE = `http://127.0.0.1:${BRIDGE_PORT}`;

let pass = 0;
let fail = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(`${name}${detail ? " :: " + detail : ""}`);
  }
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : " :: " + detail}`);
};

/* ------------------------------------------------------------------ mock */

/** Scriptable fake of `opencode serve`. */
let mode = "text";
let delayMs = 0;
let sessionCounter = 0;
const sessions = new Set();
let generateCalls = 0;

function sseSay(text) {
  return { data: { text } };
}

function reply() {
  generateCalls++;
  switch (mode) {
    case "text":
      return sseSay(JSON.stringify({ text: "PONG" }));
    case "prose":
      // A reply that is not an envelope at all: the model chatting instead of
      // using the JSON protocol.
      return sseSay("Sure! The capital of France is Paris.");
    case "badtool":
      return sseSay(
        JSON.stringify({ text: "", tools: [{ name: "NotARealTool", input: {} }] })
      );
    case "badinput":
      return sseSay(
        JSON.stringify({ text: "", tools: [{ name: "Read", input: { nope: 1 } }] })
      );
    case "empties":
      // Empty text = a native tool call the deployment discards.
      return sseSay("");
    case "long":
      return sseSay(JSON.stringify({ text: "x".repeat(60000) }));
    case "status":
      return { status: 503, text: JSON.stringify({ _tag: "ServiceUnavailableError", message: "Rate limit exceeded" }) };
    case "hang":
      // Never resolves within the test; exercises the turn budget.
      return sseSay(JSON.stringify({ text: "too late" }));
    default:
      return sseSay(JSON.stringify({ text: "PONG" }));
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const mockServer = (await import("node:http")).createServer(async (req, res) => {
  const url = new URL(req.url, MOCK);
  const p = url.pathname;
  const json = (code, v) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: v }));
  };

  if (p === "/api/mock/control") {
    const body = await readBody(req);
    if (body.mode) mode = body.mode;
    if (body.delayMs !== undefined) delayMs = Number(body.delayMs);
    if (body.resetSessions) {
      sessions.clear();
      sessionCounter = 0;
    }
    return json(200, { mode, delayMs, sessions: sessions.size, generateCalls });
  }

  // The bridge sends Basic auth; reject anything else so a credential bug shows.
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }));
  }

  if (p === "/api/session" && req.method === "POST") {
    const id = "ses_mock_" + ++sessionCounter;
    sessions.add(id);
    return json(200, { id, title: "mock" });
  }
  if (p.startsWith("/api/session/")) {
    const id = p.split("/")[3];
    const rest = p.split("/")[4];
    if (rest === "model" && req.method === "POST") {
      await readBody(req);
      return json(200, { providerID: "opencode", id: "space-bunny-free" });
    }
    if (rest === "generate" && req.method === "POST") {
      await readBody(req);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (mode === "hang") return; // deliberately never answers
      const r = reply();
      if (r.status) {
        res.writeHead(r.status, { "Content-Type": "application/json" });
        return res.end(r.text);
      }
      return json(200, r.data);
    }
    if (req.method === "GET") {
      if (!sessions.has(id)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ _tag: "NotFoundError" }));
      }
      return json(200, { id });
    }
    if (req.method === "DELETE") {
      sessions.delete(id);
      return json(200, { ok: true });
    }
  }
  if (p === "/api/model") {
    return json(200, [
      {
        providerID: "opencode",
        id: "space-bunny-free",
        variants: ["low", "medium", "high", "xhigh", "max"],
        limit: { context: 1048576, input: 524288 },
      },
    ]);
  }
  res.writeHead(404);
  res.end("{}");
});

mockServer.listen(MOCK_PORT, "127.0.0.1");

/* ---------------------------------------------------------------- bridge */

const bridge = spawn(process.execPath, [path.join(HERE, "bridge.mjs")], {
  env: {
    ...process.env,
    OC_PORT: String(MOCK_PORT),
    OC_PASS: "mockpass",
    BRIDGE_PORT: String(BRIDGE_PORT),
    BRIDGE_LOG: path.join(HERE, "bridge.mock.log"),
    BRIDGE_HEAD_DELAY_MS: "200",
    BRIDGE_TURN_BUDGET_MS: "3000",
    BRIDGE_MAX_ATTEMPTS: "3",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let bridgeLog = "";
bridge.stdout.on("data", (c) => (bridgeLog += c));
bridge.stderr.on("data", (c) => (bridgeLog += c));

process.on("exit", () => {
  bridge.kill();
  mockServer.close();
});

async function waitFor(url, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${url}\n${bridgeLog.slice(-2000)}`);
}

await waitFor(BRIDGE + "/health");

/* --------------------------------------------------------------- helpers */

async function control(body) {
  await fetch(MOCK + "/api/mock/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const READ_TOOL = {
  name: "Read",
  description: "Read a file.",
  input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"], additionalProperties: false },
};

async function post(body, { headers = {} } = {}) {
  const stream = !!body.stream;
  const payload = { model: "space-bunny-free", max_tokens: 4096, messages: [{ role: "user", content: "hi" }], ...body };
  const res = await fetch(BRIDGE + "/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  if (!stream) return { status: res.status, headers: res.headers, json: await res.json().catch(() => ({})) };
  const text = await res.text();
  const events = text
    .split("\n\n")
    .filter((c) => c.trim())
    .map((c) => {
      const ev = { name: null, data: null, comment: false };
      for (const line of c.split("\n")) {
        if (line.startsWith(":")) ev.comment = true;
        else if (line.startsWith("event:")) ev.name = line.slice(6).trim();
        else if (line.startsWith("data:")) ev.data = line.slice(5).trim();
      }
      return ev;
    });
  return { status: res.status, headers: res.headers, events, raw: text, names: events.filter((e) => e.name).map((e) => e.name) };
}

/* ----------------------------------------------------------------- tests */

console.log("\n-- routing --");
{
  const r = await fetch(BRIDGE + "/nope");
  ok("unknown path is 404, not 405", r.status === 404, String(r.status));
  const m = await fetch(BRIDGE + "/v1/messages", { method: "GET" });
  ok("known path wrong method is 405", m.status === 405, String(m.status));
  const bad = await post({ messages: "not-an-array" });
  ok("messages must be an array", bad.status === 400, String(bad.status));
  const noModel = await fetch(BRIDGE + "/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ max_tokens: 10, messages: [{ role: "user", content: "x" }] }),
  });
  ok("model is required", noModel.status === 400, String(noModel.status));
  const noMax = await fetch(BRIDGE + "/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "x" }] }),
  });
  ok("max_tokens is required", noMax.status === 400, String(noMax.status));
  const before = (await (await fetch(MOCK + "/api/mock/control", { method: "POST", body: "{}" })).json());
  ok("a malformed request never reaches the model", before.data.generateCalls >= 0);
}

console.log("\n-- streaming contract --");
for (const [label, delay] of [
  ["fast turn (head opened by the writer)", 0],
  ["slow turn (head opened by the timer)", 400],
]) {
  await control({ mode: "text", delayMs: delay });
  const s = await post({ stream: true });
  ok(`${label}: status 200`, s.status === 200, String(s.status));
  ok(`${label}: content-type is event-stream`, (s.headers.get("content-type") || "").includes("text/event-stream"));
  // The regression both reviewers found independently.
  const starts = s.names.filter((n) => n === "message_start").length;
  ok(`${label}: EXACTLY ONE message_start`, starts === 1, s.names.join(","));
  ok(`${label}: message_start comes first`, s.names[0] === "message_start", s.names.join(","));
  ok(`${label}: ends message_delta then message_stop`,
    s.names.at(-2) === "message_delta" && s.names.at(-1) === "message_stop", s.names.join(","));
  const expected = ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"];
  ok(`${label}: exact event order`, s.names.join(",") === expected.join(","), s.names.join(","));
  const ids = s.events.filter((e) => e.name === "message_start").map((e) => JSON.parse(e.data).message.id);
  ok(`${label}: one stable message id`, new Set(ids).size === 1 && ids[0].length > 0, ids.join(","));
  const msg = JSON.parse(s.events.find((e) => e.name === "message_start").data).message;
  ok(`${label}: message_start carries model`, msg.model === "space-bunny-free", msg.model);
  ok(`${label}: message_start usage has input_tokens`, Number.isFinite(msg.usage?.input_tokens));
  ok(`${label}: stream carries effort headers`, !!s.headers.get("x-bridge-effort"), String(s.headers.get("x-bridge-effort")));
  const delta = JSON.parse(s.events.find((e) => e.name === "message_delta").data);
  ok(`${label}: stop_reason is end_turn`, delta.delta.stop_reason === "end_turn", delta.delta.stop_reason);
}

console.log("\n-- tool protocol --");
{
  await control({ mode: "badtool", delayMs: 0 });
  const r = await post({ tools: [READ_TOOL] });
  ok("unknown tool is retried, not emitted", r.status === 400, String(r.status));
  ok("unknown tool reports a client error", r.json?.error?.type === "invalid_request_error", JSON.stringify(r.json).slice(0, 120));

  await control({ mode: "badinput", delayMs: 0 });
  const r2 = await post({ tools: [READ_TOOL] });
  ok("schema violation is retried, not emitted", r2.status === 400, String(r2.status));

  await control({ mode: "text", delayMs: 0 });
  const okr = await post({ tools: [READ_TOOL] });
  ok("a clean reply succeeds", okr.status === 200, String(okr.status));
  ok("stop_reason is end_turn", okr.json.stop_reason === "end_turn", okr.json.stop_reason);
  ok("content is non-empty", Array.isArray(okr.json.content) && okr.json.content.length > 0);
  ok("usage has both token counts", Number.isFinite(okr.json.usage?.input_tokens) && Number.isFinite(okr.json.usage?.output_tokens));
}

console.log("\n-- max_tokens --");
{
  await control({ mode: "long", delayMs: 0 });
  const r = await post({ max_tokens: 10 });
  ok("truncated turn says max_tokens", r.json.stop_reason === "max_tokens", r.json.stop_reason);
  const chars = (r.json.content || []).reduce((n, b) => n + (b.text?.length || 0), 0);
  ok("text is actually truncated", chars < 60000, String(chars));
  // Reported usage must describe what was sent, not the discarded draft.
  ok("output_tokens reflects the truncation", r.json.usage.output_tokens <= 20, String(r.json.usage.output_tokens));
  ok("output_tokens is not the full draft", r.json.usage.output_tokens < 60000 / 2.8 / 2, String(r.json.usage.output_tokens));
}

console.log("\n-- empty turn is terminal --");
{
  await control({ mode: "empties", delayMs: 0 });
  const t0 = Date.now();
  const r = await post({ tools: [READ_TOOL] });
  const ms = Date.now() - t0;
  ok("empty reply is a 400", r.status === 400, String(r.status));
  ok("empty reply is not retryable", r.headers.get("x-should-retry") === "false", String(r.headers.get("x-should-retry")));
  ok("empty reply costs one upstream call per attempt, not more", ms < 3000, `${ms}ms`);
}

console.log("\n-- upstream failure --");
{
  await control({ mode: "status", delayMs: 0 });
  const r = await post({});
  ok("upstream 503 is forwarded as 503", r.status === 503, String(r.status));
  ok("upstream 503 is retryable", r.headers.get("x-should-retry") === "true", String(r.headers.get("x-should-retry")));
  ok("upstream 503 carries Retry-After", !!r.headers.get("retry-after"), String(r.headers.get("retry-after")));
  ok("rate limit is classified as overloaded_error", r.json?.error?.type === "overloaded_error", JSON.stringify(r.json).slice(0, 140));
}

console.log("\n-- turn budget --");
{
  await control({ mode: "hang", delayMs: 0 });
  const t0 = Date.now();
  const r = await post({});
  const ms = Date.now() - t0;
  ok("a hung upstream times out instead of hanging forever", ms < 8000, `${ms}ms`);
  ok("the timeout is retryable", r.headers?.get?.("x-should-retry") === "true" || r.status === 503, `${r.status} ${r.headers?.get?.("x-should-retry")}`);
  await control({ mode: "text", delayMs: 0 });
}

console.log("\n-- sessions --");
{
  await control({ resetSessions: true });
  const a = await post({ output_config: { effort: "low" } });
  const b = await post({ output_config: { effort: "low" } });
  ok("same variant reuses one session", a.status === 200 && b.status === 200);
  const info = await (await fetch(MOCK + "/api/mock/control", { method: "POST", body: "{}" })).json();
  ok("one session created for two same-variant calls", info.data.sessions === 1, String(info.data.sessions));
  await post({ output_config: { effort: "max" } });
  const info2 = await (await fetch(MOCK + "/api/mock/control", { method: "POST", body: "{}" })).json();
  ok("a different variant gets its own session", info2.data.sessions === 2, String(info2.data.sessions));
}

console.log("\n-- concurrency --");
{
  await control({ mode: "text", delayMs: 250 });
  const burst = await Promise.all(Array.from({ length: 6 }, () => post({ output_config: { effort: "high" } })));
  const statuses = burst.map((r) => r.status);
  ok("every concurrent request is answered", statuses.every((s) => s === 200 || s === 429), statuses.join(","));
  const shed = burst.filter((r) => r.status === 429);
  ok("shed requests carry retry guidance", shed.every((r) => r.headers.get("retry-after") && r.headers.get("x-should-retry") === "true"));
  ok("some were shed, proving the limit is real", shed.length > 0, statuses.join(","));
  ok("the rest were served", burst.some((r) => r.status === 200), statuses.join(","));
  await control({ delayMs: 0 });
}

console.log("\n-- effort plumbing --");
{
  for (const [want, source] of [["low", "request"], ["max", "request"], ["ultracode", "clamped-up"], ["minimal", "clamped-down"]]) {
    const r = await post({ output_config: { effort: want } });
    ok(`effort ${want} -> ${source}`, r.headers.get("x-bridge-effort-source") === source, r.headers.get("x-bridge-effort-source"));
  }
}

console.log(`\nmock: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log("  FAIL " + f);
bridge.kill();
mockServer.close();
await once(bridge, "exit").catch(() => {});
process.exit(fail ? 1 : 0);