#!/usr/bin/env node
/**
 * Measure model behaviour cheaply.
 *
 *   node probe-behaviour.mjs            4 cases, ~1-2k tokens each
 *   node probe-behaviour.mjs 10         repeat for a rate
 *
 * A full `claude -p` turn costs roughly 32k input tokens before the model does
 * anything: a 23-tool schema block plus the Claude Code system prompt. That is
 * the wrong instrument for asking "does the model narrate instead of calling a
 * tool?". This probe sends three tools and a one-line prompt instead, so a
 * measurement costs about a twentieth as much.
 *
 * It reports, never asserts. A free model is allowed to behave differently on a
 * different day; a suite that fails on that teaches you to ignore the suite.
 * Use test-mock.mjs for contracts, and this for trends.
 */
const BRIDGE = "http://127.0.0.1:8787";

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

const CASES = [
  { name: "reads", prompt: "Read notes.txt and tell me what it says." },
  { name: "runs", prompt: "Run `echo hi` with the shell and report the output." },
  { name: "writes", prompt: "Write the single word ok into out.txt." },
  { name: "two", prompt: "Read notes.txt, then write that text into copy.txt." },
  {
    // The one that matters. Without a tool_result in the last user message the
    // bridge is not in a tool loop, so the narration guard never engages and the
    // probe measures nothing about it. This fake result costs about 40 tokens.
    name: "midloop",
    prompt: "Now report what you found.",
    midLoop: true,
  },
];

const N = Number(process.argv[2] || 1);

async function one(c) {
  const t0 = Date.now();
  // A plausible mid-loop shape, so the bridge's `midToolLoop` path is reachable
  // from a probe. Claude Code attaches a system-reminder to the same message,
  // which is exactly what used to switch that guard off.
  const messages = c.midLoop
    ? [
        { role: "user", content: "Read notes.txt." },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "notes.txt" } }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "alpha beta gamma" },
            { type: "text", text: "<system-reminder>internal harness note</system-reminder>" },
          ],
        },
      ]
    : [{ role: "user", content: c.prompt }];

  const r = await fetch(BRIDGE + "/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "space-bunny-free",
      max_tokens: 2048,
      tools: TOOLS,
      messages,
    }),
  });
  const j = await r.json().catch(() => ({}));
  const blocks = Array.isArray(j.content) ? j.content : [];
  const calls = blocks.filter((b) => b.type === "tool_use");
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  return {
    status: r.status,
    ms: Date.now() - t0,
    stop: j.stop_reason,
    // Not exposed as a header yet; counted from the bridge log instead, so this
    // stays 1 and the retry column reads "unknown" until it is.
    attempts: 1,
    calls: calls.map((b) => b.name),
    textLen: text.length,
    // The failure this whole exercise exists to measure: a well-formed sentence
    // that announces work instead of doing it.
    narrated: /^\s*(ok|okay|sure|got it|alright)\b|\b(let me|i'?ll|continuing|going to|kicking off)\b/i.test(text),
    usage: j.usage,
    // Reported so a rate limit is not mistaken for a bridge bug. They look
    // identical from the outside: a 503 and no content.
    why: j?.error?.message || null,
  };
}

(async () => {
  const tallies = { toolCall: 0, prose: 0, narrated: 0, error: 0, total: 0, spent: 0, retries: 0 };
  for (let round = 0; round < N; round++) {
    for (const c of CASES) {
      let r;
      try {
        r = await one(c);
      } catch (e) {
        console.log(`[${c.name}] request failed: ${e.message}`);
        tallies.error++;
        tallies.total++;
        continue;
      }
      tallies.total++;
      // Measured, not assumed. The bridge reports the total input across every
      // attempt, so this already includes what retries cost.
      tallies.spent += Number(r.usage?.input_tokens || 0);
      if (r.attempts > 1) tallies.retries++;
      const did = r.calls.length > 0;
      if (r.status !== 200) tallies.error++;
      else if (did) tallies.toolCall++;
      else tallies.prose++;
      if (r.narrated && !did) tallies.narrated++;

      console.log(
        `[${c.name}] ${r.status} ${(r.ms / 1000).toFixed(1)}s stop=${r.stop} ` +
          `calls=[${r.calls.join(",")}] text=${r.textLen}` +
          `${r.narrated && !did ? "  <-- NARRATED, did nothing" : ""}` +
          `${r.status !== 200 ? `  <-- ${r.why || "ERROR"}` : ""}`
      );
      await new Promise((x) => setTimeout(x, 1200));
    }
  }

  const ok = tallies.total - tallies.error;
  console.log(`\nturns: ${tallies.total}   ok: ${ok}   errors: ${tallies.error}`);
  if (ok) {
    console.log(`  tool call  ${tallies.toolCall}/${ok} (${Math.round((100 * tallies.toolCall) / ok)}%)`);
    console.log(`  prose only ${tallies.prose}/${ok}`);
    console.log(`  narrated   ${tallies.narrated}/${ok}  <- turned into a 400 instead of a silent no-op`);
  }
  console.log(`  input tokens   ${tallies.spent} across ${tallies.total} turns (retries: ${tallies.retries})`);
  console.log(`  one claude -p turn is ~32000, so this run cost roughly ${Math.round(tallies.spent / 320)}% of a single one`);
})();