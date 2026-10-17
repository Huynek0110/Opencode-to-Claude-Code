#!/usr/bin/env node
/** Exercise the parts of the bridge that only matter under real Claude Code load. */
const BRIDGE = "http://127.0.0.1:8787";

const SYSTEM = "You are Claude Code, a CLI coding assistant.";

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`);
  }
};

const READ_TOOL = {
  name: "Read",
  description: "Read a file.",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"],
  },
};

async function call(body, headers = {}) {
  const t0 = Date.now();
  const r = await fetch(BRIDGE + "/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model: "space-bunny-free", max_tokens: 2048, system: SYSTEM, ...body }),
  });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    j = { raw: text.slice(0, 200) };
  }
  return {
    status: r.status,
    ms: Date.now() - t0,
    j,
    headers: r.headers,
    retryAfter: r.headers.get("retry-after"),
    shouldRetry: r.headers.get("x-should-retry"),
  };
}

(async () => {
  // 1. context overflow -> 400 naming the token limit, not a retryable 503
  const huge = "lorem ipsum dolor sit amet ".repeat(140_000); // ~2M chars
  const over = await call({ messages: [{ role: "user", content: huge }] });
  console.log(
    "[overflow]", over.status, over.headers.get("x-should-retry"), "|",
    JSON.stringify(over.j.error?.message || over.j).slice(0, 150)
  );

  // 2. tool_choice: any must come back with a tool call
  for (const choice of [{ type: "any" }, { type: "tool", name: "Read" }, { type: "none" }]) {
    const r = await call({
      tool_choice: choice,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "Read notes.md and tell me what it says." }],
    });
    console.log(
      `[tool_choice ${choice.type}${choice.name ? ":" + choice.name : ""}]`,
      r.status, r.j.stop_reason, "blocks=" + (r.j.content || []).map((c) => c.type + (c.name ? ":" + c.name : "")).join(",")
    );
  }

  // 3. session reuse: keyed by effort variant, bounded, no leaks
  const sid = { "x-claude-code-session-id": "reuse-test-1" };
  for (let i = 1; i <= 3; i++) {
    const r = await call({ messages: [{ role: "user", content: "Say OK." + i }] }, sid);
    console.log(`[reuse ${i}]`, r.status, r.j.content?.[0]?.text);
  }
  const dbg = await (await fetch(BRIDGE + "/debug/sessions")).json();
  console.log("[sessions]", dbg.count, "variants", JSON.stringify(dbg.variants));
  // Sessions are keyed by effort variant, so the count tracks distinct variants,
  // never the number of requests. Five variants is the hard ceiling.
  ok("sessions bounded by variant count", dbg.count <= 5, JSON.stringify(dbg));
  ok(
    "every session key is a known effort level",
    dbg.variants.every((v) => ["low", "medium", "high", "xhigh", "max", "default"].includes(v)),
    JSON.stringify(dbg.variants)
  );

  // 3b. concurrency: a burst on one variant must not create one session per request
  const before = (await (await fetch(BRIDGE + "/debug/sessions")).json()).count;
  const burst = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      call(
        { output_config: { effort: "xhigh" }, messages: [{ role: "user", content: "Say P" + i }] },
        { "x-claude-code-session-id": "concurrent-1" }
      )
    )
  );
  const after = (await (await fetch(BRIDGE + "/debug/sessions")).json()).count;
  const statuses = burst.map((r) => r.status);
  console.log("[concurrent 6x] statuses", statuses.join(","), "sessions", before, "->", after);
  ok("concurrent burst adds at most one session", after - before <= 1, `${before} -> ${after}`);
  // Six requests against MAX_INFLIGHT=4 means two are shed. They must be shed
  // WITH a 429 the client can act on, not silently dropped - and the assertion
  // above used to pass precisely because those two never got that far.
  const shed = burst.filter((r) => r.status === 429);
  const served = burst.filter((r) => r.status === 200);
  ok("every request got a status", statuses.every((s) => s === 200 || s === 429), statuses.join(","));
  ok("no request was dropped", served.length + shed.length === 6, statuses.join(","));
  ok("shed requests answer 429 with retry guidance", shed.every((r) => r.retryAfter === "5" && r.shouldRetry === "true"),
    shed.map((r) => `${r.status}/${r.retryAfter}/${r.shouldRetry}`).join(" "));
  console.log(`[concurrency] served=${served.length} shed=${shed.length}`);

  // 5. request class routing
  const aux = await call(
    { output_config: { effort: "high" }, messages: [{ role: "user", content: "Say OK." }] },
    { "x-claude-code-request-class": "auxiliary" }
  );
  console.log("[auxiliary class] effort =", aux.j._bridge?.effort ?? aux.headers?.get?.("x-bridge-effort"));
  const main = await call(
    { output_config: { effort: "high" }, messages: [{ role: "user", content: "Say OK." }] },
    { "x-claude-code-request-class": "main" }
  );
  console.log("[main class]      effort =", main.j._bridge?.effort ?? main.headers?.get?.("x-bridge-effort"));

  // 6. count_tokens agrees with the guard
  const ct = await (
    await fetch(BRIDGE + "/v1/messages/count_tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: SYSTEM, messages: [{ role: "user", content: "hi" }] }),
    })
  ).json();
  console.log("[count_tokens]", ct.input_tokens);

  // 7. huge tool_result gets capped rather than blowing the window
  const big = "X".repeat(200_000);
  const capped = await call({
    tools: [READ_TOOL],
    messages: [
      { role: "user", content: "Read log.txt" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "log.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] },
    ],
  });
  console.log("[big tool_result]", capped.status, "ok, answer:", JSON.stringify(capped.j.content?.[0]?.text || "").slice(0, 90));

  console.log(`\nload: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();