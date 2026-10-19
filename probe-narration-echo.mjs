#!/usr/bin/env node
/**
 * Does the prompt plant the failure it warns about?
 *
 * The FINAL closer contains this, verbatim, in the text sent to the model:
 *
 *   "Continuing to read the file, and kicking off research in parallel"
 *     performs nothing, so the turn ends having done no work.
 *
 * It is offered as a NEGATIVE EXAMPLE. But it is also the single most concrete,
 * most quotable sentence anywhere in a 1 200-token prompt, and small models are
 * known to reproduce concrete strings from a prompt. The narration detector
 * exists to reject exactly that shape - so the prompt may be supplying the
 * model with the sentence that fails the turn.
 *
 * That is a hypothesis, not a finding. This measures it.
 *
 * WHAT IT MEASURES: how often the model's own reply contains a phrase that
 * appears in the prompt ONLY inside that negative example. Nothing else in the
 * protocol contains "kicking off research", so a match is unambiguous.
 *
 * COST: about 1 300 input tokens per prompt. The default of 6 is roughly 8 000
 * tokens total, against roughly 170 000 for the same six through `claude -p`.
 *
 * DO NOT RUN without quota. See AGENTS.md.
 *
 *   node probe-narration-echo.mjs [count]
 *
 * PASS CRITERION, fixed before the run so it cannot be reinterpreted:
 *   >= 25 % of replies containing an echo phrase  ->  the hypothesis is
 *   supported; the example sentence must be deleted from the prompt. Deleting
 *   ~90 characters costs ~28 tokens a turn, which is cheap against a failure
 *   mode that ends every turn it touches.
 *   < 25 %                                            ->  the example is not
 *   being copied, and the prompt is not the cause. Look elsewhere.
 *
 * It reports. It does not assert: a free model behaves differently by the hour,
 * and a suite that fails for that reason teaches you to ignore suites.
 */
const BRIDGE = process.env.BRIDGE_URL || "http://127.0.0.1:8787";

// Phrases that occur in the prompt ONLY inside the closer's negative example.
// "Continuing to read" alone is too generic to be evidence; these two are not
// used anywhere else in the contract.
const ECHOES = ["kicking off research", "Continuing to read the file"];

// Prompts that invite a plan. Each is legitimately answerable, so a good reply
// is short text and a bad one is a description of work not done.
const PROMPTS = [
  "What files are in this repository?",
  "Check whether the tests pass and tell me the result.",
  "Find every place the port is configured and list them.",
  "Look at bridge.mjs and explain how it starts.",
  "Which tools are available, and what is each for?",
  "Summarise what this project does and how to run it.",
];

async function one(prompt) {
  const t0 = Date.now();
  const r = await fetch(BRIDGE + "/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "space-bunny-free",
      max_tokens: 512,
      tools: [
        { name: "Read", description: "Read a file.", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
        { name: "Bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      ],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  const text = (Array.isArray(j.content) ? j.content : [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const echo = ECHOES.find((e) => text.toLowerCase().includes(e.toLowerCase())) || null;
  return {
    prompt,
    status: r.status,
    stop: j.stop_reason,
    echoed: echo,
    calls: (Array.isArray(j.content) ? j.content : []).filter((b) => b.type === "tool_use").length,
    textLen: text.length,
    input: Number(j.usage?.input_tokens || 0),
    ms: Date.now() - t0,
    sample: text.slice(0, 110).replace(/\s+/g, " "),
    why: j?.error?.message || null,
  };
}

const N = Math.max(1, Math.min(12, Number(process.argv[2] || PROMPTS.length)));

(async () => {
  console.log("Does the reply ever quote the negative example back?\n");
  console.log("  \"kicking off research\" and \"Continuing to read the file\" appear in the");
  console.log("  prompt ONLY as the example of what not to say.\n");

  let tokens = 0;
  let echoes = 0;
  const rows = [];

  for (const p of PROMPTS.slice(0, N)) {
    let r;
    try {
      r = await one(p);
    } catch (e) {
      console.log("  transport failure: " + e.message);
      continue;
    }
    tokens += r.input;
    if (r.echoed) echoes++;
    rows.push(r);
    console.log(
      "  " +
        (r.echoed ? "ECHO " : "     ") +
        String(r.status).padEnd(4) +
        (r.ms / 1000).toFixed(1).padStart(5) +
        "s  calls=" +
        r.calls +
        "  " +
        r.prompt.slice(0, 44)
    );
    if (r.echoed) console.log("         quoted: " + JSON.stringify(r.echoed));
    if (r.sample) console.log("         said:   " + r.sample);
    if (r.why) console.log("         error:  " + r.why.slice(0, 110));
    await new Promise((x) => setTimeout(x, 1500));
  }

  const n = rows.length || 1;
  const pct = Math.round((100 * echoes) / n);
  console.log("\n  replies that echoed the example: " + echoes + "/" + rows.length + "  (" + pct + "%)");
  console.log("  input tokens this run: ~" + tokens);
  console.log("\n  " + (pct >= 25
    ? "ABOVE the pre-registered 25% threshold. The prompt is supplying the sentence that"
      + "\n  fails the turn. Delete the example from the closer."
    : "Below the 25% threshold. The prompt is probably not the cause; look elsewhere."));
})();
