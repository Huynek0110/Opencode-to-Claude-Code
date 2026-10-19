#!/usr/bin/env node
/**
 * The cheap, reusable measurement for "can the model actually use tool call?".
 *
 * Why this exists. The only real measurement so far was `claude -p`, at roughly
 * 32 000 input tokens per turn - 23 tool schemas plus the Claude Code system
 * prompt. That is the wrong instrument twice over: it is expensive, and the
 * tools in it are the very ones being emulated, so a failure tells you nothing
 * about whether the emulation works.
 *
 * This probe sends three tools and one-line prompts. It is the smallest thing
 * that still exercises the whole path: prompt assembly, the JSON envelope,
 * parsing, alias resolution, schema validation, the retry loop, and the
 * streaming writer.
 *
 * Cost per round: about 1 500 input tokens for the four cases, versus 128 000
 * for the same four through `claude -p`.
 *
 *   node probe-toolcall.mjs          4 cases, one round
 *   node probe-toolcall.mjs 5        five rounds, for a rate
 *
 * It reports, it does not assert. A free model is allowed to behave differently
 * on a different day, and a suite that fails for that reason teaches you to
 * ignore the suite. Contracts belong in test-mock.mjs, which costs nothing.
 */
const BRIDGE = process.env.BRIDGE_URL || "http://127.0.0.1:8787";

const TOOLS = [
  {
    name: "Read",
    description: "Read a file.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "Write",
    description: "Write a file.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" }, content: { type: "string" } },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "Bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" }, description: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

/**
 * Each case says what a working model must do. `expect` is the whole contract:
 * `tool` means at least one tool_use, named in `names` if given.
 */
const CASES = [
  { name: "read", prompt: "Read notes.txt and tell me what it says.", expect: "tool", names: ["Read"] },
  { name: "run", prompt: "Run `echo hi` with the shell and report the output.", expect: "tool", names: ["Bash"] },
  { name: "write", prompt: "Write the single word ok into out.txt.", expect: "tool", names: ["Write"] },
  { name: "answer", prompt: "In one short sentence, what is the capital of France?", expect: "text" },
];

async function one(c) {
  const t0 = Date.now();
  const r = await fetch(BRIDGE + "/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "space-bunny-free",
      max_tokens: 2048,
      tools: TOOLS,
      messages: [{ role: "user", content: c.prompt }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  const blocks = Array.isArray(j.content) ? j.content : [];
  const calls = blocks.filter((b) => b.type === "tool_use");
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  const pass =
    r.status === 200 &&
    blocks.length > 0 &&
    (c.expect === "tool" ? calls.length > 0 && (!c.names || c.names.some((n) => calls.some((x) => x.name === n))) : calls.length === 0 && text.length > 0);
  return {
    status: r.status,
    pass,
    calls: calls.map((b) => b.name),
    textLen: text.length,
    stop: j.stop_reason,
    input: Number(j.usage?.input_tokens || 0),
    output: Number(j.usage?.output_tokens || 0),
    ms: Date.now() - t0,
    why: j?.error?.message || null,
  };
}

const N = Math.max(1, Number(process.argv[2] || 1));

(async () => {
  const tally = {};
  for (const c of CASES) tally[c.name] = { pass: 0, tries: 0, tokens: 0, names: new Set(), fails: [] };

  for (let round = 0; round < N; round++) {
    for (const c of CASES) {
      let r;
      try {
        r = await one(c);
      } catch (e) {
        console.log(`[${c.name}] transport failure: ${e.message}`);
        tally[c.name].tries++;
        continue;
      }
      const t = tally[c.name];
      t.tries++;
      t.tokens += r.input;
      if (r.pass) t.pass++;
      else t.fails.push(`${r.status} stop=${r.stop} calls=[${r.calls}] ${r.why || ""}`.trim());
      if (round === 0 || !r.pass) {
        console.log(
          `[${c.name}] ${r.pass ? "pass" : "FAIL"} ${r.status} ${(r.ms / 1000).toFixed(1)}s ` +
            `calls=[${r.calls.join(",")}] text=${r.textLen} in=${r.input} out=${r.output}` +
            (r.why ? `  ${r.why.slice(0, 120)}` : "")
        );
      }
      await new Promise((x) => setTimeout(x, 1500));
    }
  }

  console.log("\n=== tool call usability ===");
  let tokens = 0;
  let allOk = true;
  for (const [name, t] of Object.entries(tally)) {
    const pct = t.tries ? Math.round((100 * t.pass) / t.tries) : 0;
    tokens += t.tokens;
    if (t.pass !== t.tries) allOk = false;
    console.log(`  ${name.padEnd(8)} ${t.pass}/${t.tries}  ${pct}%   ~${t.tokens} tokens`);
    for (const f of t.fails.slice(0, 2)) console.log(`      ${f}`);
  }
  console.log(`\n  input tokens this run: ~${tokens}`);
  console.log(`  the same measurement through claude -p would be ~${tokens * 21}`);
  console.log(`\n  ${allOk ? "the model can use tool call on every case" : "NOT every case passed - read the failures above"}`);
})();