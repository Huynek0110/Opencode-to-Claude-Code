#!/usr/bin/env node
/**
 * Streaming contract tests. These assert the things that only show up on the
 * SSE path: the first event, the event order, status codes on failure, and the
 * keep-alive not leaking in as an event.
 *
 *   node test-sse.mjs
 */
const BRIDGE = process.env.BRIDGE_URL || "http://127.0.0.1:8787";

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

function parseSse(raw) {
  const events = [];
  let firstAt = null;
  let offset = 0;
  for (const chunk of raw.split("\n\n")) {
    if (!chunk.trim()) continue;
    const ev = { name: null, data: null, comment: false, at: offset };
    for (const line of chunk.split("\n")) {
      if (line.startsWith(":")) ev.comment = true;
      else if (line.startsWith("event:")) ev.name = line.slice(6).trim();
      else if (line.startsWith("data:")) ev.data = line.slice(5).trim();
    }
    if (ev.name && firstAt === null) firstAt = ev.at;
    events.push(ev);
    offset += chunk.length + 2;
  }
  return { events, firstAt };
}

async function stream(body) {
  const t0 = Date.now();
  const r = await fetch(BRIDGE + "/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-claude-code-session-id": "sse-test" },
    body: JSON.stringify({ model: "space-bunny-free", max_tokens: 1024, ...body }),
  });
  const raw = await r.text();
  const { events, firstAt } = parseSse(raw);
  return { status: r.status, headers: r.headers, raw, events, msFirstEvent: firstAt, total: Date.now() - t0 };
}

const SYSTEM = "You are Claude Code.";

(async () => {
  /* 1. a normal streamed turn */
  {
    const s = await stream({
      stream: true,
      system: SYSTEM,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    });
    ok("stream status 200", s.status === 200, String(s.status));
    ok(
      "content-type is event-stream",
      (s.headers.get("content-type") || "").includes("text/event-stream")
    );
    const named = s.events.filter((e) => e.name);
    ok("has events", named.length > 0);
    ok("FIRST EVENT IS message_start", named[0]?.name === "message_start", named[0]?.name);

    const seq = named.map((e) => e.name);
    // The assertion that was missing. `message_start` is emitted once per
    // stream, and a second copy used to go out on every turn faster than
    // HEAD_DELAY_MS - which is most of them. Checking only that the FIRST event
    // is message_start cannot see that: a duplicate passes.
    ok(
      "EXACTLY ONE message_start",
      seq.filter((n) => n === "message_start").length === 1,
      seq.join(",")
    );
    const starts = named.filter((e) => e.name === "message_start").map((e) => JSON.parse(e.data).message.id);
    ok("message id never changes mid-stream", new Set(starts).size === starts.length, starts.join(","));

    // Full sequence, checked against the contract rather than described by it:
    // one start, then N triples, then delta, then stop.
    const KNOWN = new Set([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
      "error",
    ]);
    ok("only known events", seq.every((n) => KNOWN.has(n)), seq.join(","));
    ok("no ping as an event", !seq.includes("ping"), seq.join(","));

    const shape = [];
    for (const n of seq) {
      if (n !== "content_block_delta" && shape.at(-1) !== n) shape.push(n);
    }
    const expected = ["message_start"];
    const blocks = seq.filter((n) => n === "content_block_start").length;
    for (let i = 0; i < blocks; i++) expected.push("content_block_start", "content_block_delta", "content_block_stop");
    expected.push("message_delta", "message_stop");
    ok("exact event order", shape.join(",") === expected.join(","), `got ${shape.join(",")} want ${expected.join(",")}`);

    // indices
    const idxs = named
      .filter((e) => e.name === "content_block_start")
      .map((e) => JSON.parse(e.data).index);
    ok("block indices are 0..n-1", idxs.every((v, i) => v === i), JSON.stringify(idxs));
    ok("no gap in block indices", idxs.length === (idxs.at(-1) ?? -1) + 1, JSON.stringify(idxs));

    // payloads parse
    ok("all data payloads parse", named.every((e) => { try { JSON.parse(e.data); return true; } catch { return false; } }));

    const start = named.find((e) => e.name === "message_start");
    const msg = JSON.parse(start.data).message;
    for (const k of ["id", "type", "role", "model", "content", "stop_reason", "stop_sequence", "usage"]) {
      ok(`message_start.message has ${k}`, k in msg);
    }
    console.log(`  streamed turn: ${named.length} events, first event at ${s.msFirstEvent}ms, ${s.total}ms total`);
  }

  /* 2. context overflow on the streaming path must be a real 400 */
  {
    const s = await stream({
      stream: true,
      system: SYSTEM,
      messages: [{ role: "user", content: "lorem ipsum ".repeat(220_000) }],
    });
    ok("overflow stream status 400", s.status === 400, String(s.status));
    ok("overflow not retryable", s.headers.get("x-should-retry") === "false", String(s.headers.get("x-should-retry")));
    ok(
      "overflow body names ContextWindowExceededError",
      s.raw.includes("ContextWindowExceededError")
    );
    ok("overflow body names the limit", /exceeds the limit of \d+ tokens/.test(s.raw), s.raw.slice(0, 120));
  }

  /* 3. a tool call still streams correctly */
  {
    const s = await stream({
      stream: true,
      system: SYSTEM,
      tools: [
        {
          name: "Read",
          description: "Read a file.",
          input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
        },
      ],
      messages: [{ role: "user", content: "Read notes.md and tell me what it says." }],
    });
    const named = s.events.filter((e) => e.name);
    const starts = named.filter((e) => e.name === "content_block_start").map((e) => JSON.parse(e.data));
    const tool = starts.find((b) => b.content_block.type === "tool_use");
    ok("tool_use block streamed", !!tool);
    const delta = named.find((e) => e.name === "content_block_delta" && e.data.includes("input_json_delta"));
    ok("input_json_delta present", !!delta);
    const stop = named[named.length - 2];
    ok("stop_reason tool_use", JSON.parse(stop.data).delta.stop_reason === "tool_use", stop.data);
  }

  /* 4. malformed body is a 400, not a retryable 500 */
  for (const [name, body] of [
    ["tools as object", { tools: {} }],
    ["null message", { messages: [null] }],
    ["null content block", { messages: [{ role: "user", content: [null] }] }],
  ]) {
    const r = await fetch(BRIDGE + "/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "space-bunny-free", stream: true, ...body }),
    });
    const t = await r.text();
    ok(`${name} -> 400`, r.status === 400, String(r.status));
    ok(`${name} not retryable`, r.headers.get("x-should-retry") === "false");
    ok(`${name} error envelope`, t.includes('"type":"error"'), t.slice(0, 100));
  }

  /* 5. invalid JSON body */
  {
    const r = await fetch(BRIDGE + "/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    ok("invalid json -> 400", r.status === 400, String(r.status));
  }

  console.log(`\nsse: ${pass} passed, ${fail} failed`);
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(fail ? 1 : 0);
})();