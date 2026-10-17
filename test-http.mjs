#!/usr/bin/env node
/**
 * Hermetic tests for the HTTP layer, without a bridge process, an OpenCode
 * server or a model.
 *
 * A CRITICAL defect survived two review rounds here: the streaming path called
 * `close()` before `sendError()`, so every failure that resolved inside
 * HEAD_DELAY_MS became an empty HTTP 200. Nothing could catch it because the
 * code was unreachable from a test. These tests import `DeferredSSE` and drive
 * it against a fake response.
 *
 *   node test-http.mjs
 */
import { EventEmitter } from "node:events";

let pass = 0;
let fail = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(`${name}${detail ? " :: " + detail : ""}`);
  }
};

/** Minimal stand-in for http.ServerResponse. */
class FakeRes extends EventEmitter {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.chunks = [];
    this.ended = false;
  }
  writeHead(code, headers) {
    this.statusCode = code;
    this.headers = headers || {};
    this.headersSent = true;
    return this;
  }
  write(s) {
    this.chunks.push(String(s));
    return true;
  }
  end(s) {
    if (s) this.chunks.push(String(s));
    this.ended = true;
    this.headersSent = true;
    return this;
  }
  get body() {
    return this.chunks.join("");
  }
  get events() {
    return this.body
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
  }
}

const { DeferredSSE, toAnthropicError, clampLevel, capText } = await import("./bridge.mjs");

/* --- 1. a failure before the head timer keeps the status unwritten --------- */
{
  const res = new FakeRes();
  const sse = new DeferredSSE(res, 50, null);
  await new Promise((r) => setTimeout(r, 5));
  ok("head not written yet", res.statusCode === null && !sse.written);
  // close() must not end a response that never had a head: end() would send an
  // empty 200 and make every later status code impossible.
  sse.close();
  ok("close() without head does not end the response", !res.ended);
  ok("close() without head leaves status unwritten", res.statusCode === null);
}

/* --- 2. head timer commits the head and fires onHead exactly once --------- */
{
  const res = new FakeRes();
  let heads = 0;
  const sse = new DeferredSSE(res, 20, () => heads++);
  sse.event("message_start", { type: "message_start" });
  ok("first event commits the head", res.statusCode === 200);
  ok("first event is message_start", res.events[0]?.name === "message_start");
  sse.event("message_stop", { type: "message_stop" });
  ok("onHead fired once", heads === 1);
  sse.close();
  ok("close() after head ends the response", res.ended);
  const names = res.events.map((e) => e.name);
  ok("event order", names[0] === "message_start" && names.at(-1) === "message_stop", names.join(","));
}

/* --- 3. the head timer alone opens the stream, so the user sees progress -- */
{
  const res = new FakeRes();
  const sse = new DeferredSSE(res, 20, () =>
    sse.event("message_start", { type: "message_start", message: { id: "m" } })
  );
  await new Promise((r) => setTimeout(r, 60));
  ok("timer commits the head", res.statusCode === 200);
  ok("message_start opened on the timer", res.events[0]?.name === "message_start");
  sse.comment("keep-alive");
  ok("keep-alive is a comment, not an event", res.events.at(-1)?.comment === true);
  sse.close();
}

/* --- 4. comment() before the head is a no-op, never a premature write ----- */
{
  const res = new FakeRes();
  const sse = new DeferredSSE(res, 1000, null);
  sse.comment("too early");
  ok("comment before head writes nothing", res.body === "" && res.statusCode === null);
  sse.close();
}

/* --- 5. writeHead failing does not throw out of the event path ----------- */
{
  const res = new FakeRes();
  res.writeHead = () => {
    throw new Error("socket gone");
  };
  const sse = new DeferredSSE(res, 10, null);
  let threw = false;
  try {
    sse.event("message_start", { a: 1 });
  } catch {
    threw = true;
  }
  ok("event on a dead socket does not throw", !threw);
  sse.close();
}

/* --- 6. error taxonomy --------------------------------------------------- */
{
  const ctx = Object.assign(new Error("prompt is too long: ContextWindowExceededError - x"), {
    name: "ContextTooLong",
  });
  const e1 = toAnthropicError(ctx);
  ok("overflow is 400", e1.status === 400);
  ok("overflow not retryable", e1.shouldRetry === false);
  ok("overflow names the phrase Claude Code needs", e1.message.includes("ContextWindowExceededError"));

  const up = Object.assign(new Error("opencode -> 503 Upstream request failed"), { status: 503 });
  const e2 = toAnthropicError(up);
  ok("upstream retryable", e2.shouldRetry === true);
  ok("upstream is overloaded_error", e2.type === "overloaded_error");

  const empty = Object.assign(new Error("no usable reply"), { name: "EmptyTurn" });
  const e3 = toAnthropicError(empty);
  ok("empty turn not retryable", e3.shouldRetry === false);

  const bug = new TypeError("x.map is not a function");
  ok("internal bug not retryable", toAnthropicError(bug).shouldRetry === false);
  ok("abort is not retryable", toAnthropicError(Object.assign(new Error("x"), { name: "AbortError" })).shouldRetry === false);
}

/* --- 7. effort clamping direction --------------------------------------- */
{
  ok("above ceiling -> max", clampLevel("ultracode").level === "max");
  ok("below floor -> low", clampLevel("minimal").level === "low");
  ok("known level passes through", clampLevel("high").level === "high");
  ok("unknown word -> default", clampLevel("banana").source === "unsupported");
  // "off" means the user asked for no reasoning. Clamping it UP would be the
  // expensive direction the code's own docstring warns about.
  ok("off clamps to the floor", clampLevel("off").level === "low", clampLevel("off").level);
  ok("none clamps to the floor", clampLevel("none").level === "low", clampLevel("none").level);
  ok("clampLevel never returns null", ["low", "medium", "high", "xhigh", "max", "off", "", "?"].every((v) => clampLevel(v).level !== null));
}

/* --- 8. a timeout is retryable, not an internal error ------------------- */
{
  // This is the exact rejection AbortSignal.timeout produces. Its message reads
  // "aborted due to timeout", which the message regex alone does not match, so
  // it used to be reported as a hard 500 that Claude Code refuses to retry.
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const e = toAnthropicError(timeout);
  ok("timeout is 503", e.status === 503, String(e.status));
  ok("timeout is overloaded_error", e.type === "overloaded_error", e.type);
  ok("timeout is retryable", e.shouldRetry === true);
  ok("timeout message is readable", !/DOMException|due to timeout/.test(e.message), e.message);

  const undone = new DOMException("This operation was aborted", "AbortError");
  ok("client abort stays 499", toAnthropicError(undone).status === 499);

  const tooBig = Object.assign(new Error("request body exceeds 67108864 bytes"), { status: 413 });
  ok("oversized body is 413", toAnthropicError(tooBig).status === 413, String(toAnthropicError(tooBig).status));
  ok("oversized body is not retried", toAnthropicError(tooBig).shouldRetry === false);

  // An internal bug must not leak its message or claim to be an upstream fault.
  const bug = toAnthropicError(new TypeError("cannot read properties of undefined (reading 'id')"));
  ok("internal error is 500", bug.status === 500);
  ok("internal error hides its detail", !/undefined/.test(bug.message), bug.message);
  ok("internal error not retryable", bug.shouldRetry === false);
}

/* --- 9. capText respects its budget ------------------------------------- */
{
  const long = Array.from({ length: 5000 }, (_, i) => "line " + i).join("\n");
  for (const cap of [200, 2000, 24000]) {
    const out = capText(long, cap);
    ok(`capText(${cap}) respects the budget`, out.length <= cap, `got ${out.length}`);
    ok(`capText(${cap}) says what it dropped`, out.includes("omitted by the bridge"));
  }
  // The pathological case: a tiny budget used to produce a marker longer than
  // the input it was trimming.
  ok("capText(0) does not inflate", capText("abcde", 0).length <= 6, capText("abcde", 0).length);
  ok("short text is untouched", capText("hello", 1000) === "hello");
  ok("empty text is safe", capText("", 100) === "" && capText(null, 100) === null);
}

console.log(`\nhttp: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log("  FAIL " + f);
process.exit(fail ? 1 : 0);