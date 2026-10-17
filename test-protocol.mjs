#!/usr/bin/env node
/** Protocol-compliance probe: cases where a model tends to chat instead of calling a tool. */
const BRIDGE = "http://127.0.0.1:8787";

const TOOLS = [
  {
    name: "Read",
    description: "Read a file from the local filesystem.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
  {
    name: "Bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" }, description: { type: "string" } },
      required: ["command"],
    },
  },
];

const SYSTEM = `You are Claude Code, a CLI coding assistant.
Always inspect the repo before answering questions about it.`;

const CASES = [
  ["must read", "What is in config.json? Read it first.", true],
  ["must run cmd", "How many files are in this directory? Run a command to find out.", true],
  ["should not call", "In one sentence, what is the capital of France?", false],
  ["two tools", "Read notes.md and also run: dir /b", true],
];

(async () => {
  let pass = 0;
  const failures = [];
  for (const [name, prompt, expectTool] of CASES) {
    const t0 = Date.now();
    const r = await fetch(BRIDGE + "/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "space-bunny-free",
        max_tokens: 4096,
        system: SYSTEM,
        tools: TOOLS,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const j = await r.json();
    const kinds = (j.content || []).map((b) => b.type + (b.name ? ":" + b.name : ""));
    const leaked = JSON.stringify(j).includes("[bridge]");
    const gotTool = kinds.some((k) => k.startsWith("tool_use"));
    const okThis =
      r.status === 200 && !leaked && (expectTool ? gotTool : !gotTool) && Array.isArray(j.content) && j.content.length > 0;
    console.log(
      `[${name}] ${((Date.now() - t0) / 1000).toFixed(1)}s status=${r.status} stop=${j.stop_reason} blocks=${kinds.join(",")}` +
        (leaked ? "  LEAKED-BRIDGE-WARNING" : "") +
        (okThis ? "" : "  FAIL")
    );
    if (okThis) pass++;
    else {
      const why = [
        `status=${r.status}`,
        leaked ? "bridge marker leaked into the reply" : null,
        expectTool && !gotTool ? "expected a tool call" : null,
        !expectTool && gotTool ? "called a tool when it should have answered" : null,
        !Array.isArray(j.content) || j.content.length === 0 ? "empty content" : null,
      ].filter(Boolean);
      failures.push(`${name}: ${why.join("; ")}`);
    }
    for (const b of j.content || []) {
      if (b.type === "tool_use") console.log("    ->", b.name, JSON.stringify(b.input));
      if (b.type === "text") console.log("    text:", JSON.stringify(b.text).slice(0, 160));
    }
  }
  console.log(`\nclean: ${pass}/${CASES.length}`);
  for (const f of failures) console.log("  FAIL " + f);
  // This gate used to be `!leaked` alone, and `leaked` could only be true once
  // a tool result had been trimmed - which none of these cases do. The suite
  // therefore reported 4/4 and exited 0 no matter what the model did.
  process.exit(pass === CASES.length ? 0 : 1);
})();