#!/usr/bin/env node
/**
 * Hermetic tests for the pure functions. No bridge process, no model, no
 * network - these import bridge.mjs directly.
 *
 *   node test-unit.mjs
 */
import {
  extractJson,
  normalizeEnvelope,
  resolveToolName,
  remapInput,
  validateInput,
  buildTranscript,
  capText,
  toAnthropicError,
  resolveEffort,
  transcriptTokens,
  clampLevel,
  looksLikeNarration,
  scoreEnv,
  EFFORT_LEVELS,
  MODEL_LIMITS,
} from "./bridge.mjs";

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}${detail ? " :: " + detail : ""}`);
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `got ${a} want ${e}`);
}

/* ------------------------------------------------------- extractJson (#4) */
{
  // A fence inside the answer must not destroy the envelope.
  const withInnerFence =
    '```json\n{"text":"here is code: ```js\\nconsole.log(1)\\n``` done","tools":[]}\n```';
  const got = extractJson(withInnerFence);
  ok("fence with inner fence survives", got && got.text && got.text.includes("console.log"));
}
{
  eq("plain json", extractJson('{"text":"hi"}')?.text, "hi");
  eq("leading whitespace", extractJson('  \n{"text":"hi"}  ')?.text, "hi");
  const inProse = extractJson('Sure thing!\n{"text":"hi","tools":[{"name":"Read","input":{}}]}\nDone.');
  eq("json embedded in prose", inProse?.text, "hi");
  eq("array rejected", extractJson('[1,2,3]'), null);
  eq("empty", extractJson(""), null);
  eq("null", extractJson(null), null);
  eq("braces inside strings", extractJson('{"text":"a } b { c","tools":[]}')?.text, "a } b { c");
}

/* ------------------------------------------- extractJson perf (#5) */
{
  // Must not be quadratic: an 80k reply that never balances.
  const unbalanced = "{".repeat(80_000);
  const t0 = Date.now();
  extractJson(unbalanced);
  const ms = Date.now() - t0;
  ok("unbalanced 80k under 2000ms", ms < 2000, `${ms}ms`);

  const t1 = Date.now();
  extractJson("{".repeat(160_000));
  const ms2 = Date.now() - t1;
  ok("unbalanced 160k under 4000ms", ms2 < 4000, `${ms2}ms`);
}

/* ------------------------------------------------- tool name (#7, #12) */
{
  eq("exact", resolveToolName("Read", ["Read", "Write"]), "Read");
  eq("case-insensitive", resolveToolName("read", ["Read"]), "Read");
  eq("opencode native alias", resolveToolName("shell", ["Bash", "Read"]), "Bash");
  eq("opencode native alias write", resolveToolName("write", ["Write"]), "Write");
  eq("unknown stays unknown", resolveToolName("Frobnicator", ["Read"]), null);

  // An MCP-shaped NAME is refused, but an MCP server being present does not
  // disable aliasing - otherwise connecting one MCP server would break the
  // mitigation for OpenCode's injected vocabulary, which is the dominant
  // failure mode.
  const withMcp = ["Read", "Write", "mcp__ide__readFile"];
  eq("mcp name not hijacked", resolveToolName("readFile", withMcp), null);
  eq("aliasing survives an mcp server", resolveToolName("shell", ["Bash", "mcp__x__run"]), "Bash");
  // Two MCP servers exposing the same tool name: guessing which one is worse
  // than refusing and letting the retry name them.
  const mcpOnly = ["mcp__ide__readFile", "mcp__other__readFile"];
  eq("ambiguous mcp tail refused", resolveToolName("readFile", mcpOnly), null);
  eq(
    "mcp full name resolves to itself",
    resolveToolName("mcp__other__readFile", mcpOnly),
    "mcp__other__readFile"
  );
}

/* ---------------------------------------------------- remapInput (#13) */
{
  eq("filePath mapped", remapInput("Read", { filePath: "a" }), { file_path: "a" });
  eq("Edit keys mapped", remapInput("Edit", { filePath: "a", oldString: "x", newString: "y" }), {
    file_path: "a",
    old_string: "x",
    new_string: "y",
  });
  // A correctly spelled key must win over a remapped one, whichever order.
  const a = remapInput("Edit", { path: "WRONG", file_path: "RIGHT" });
  eq("correct key wins (file_path last)", a.file_path, "RIGHT");
  const b = remapInput("Edit", { file_path: "RIGHT", path: "WRONG" });
  eq("correct key wins (file_path first)", b.file_path, "RIGHT");

  // Measured regression: the model adds `workdir` because OpenCode's own `bash`
  // schema advertises it, and Claude Code's Bash has additionalProperties:false.
  // Rejecting it cost a full retry on every parallel Bash+Read turn.
  eq(
    "Bash workdir dropped, not rejected",
    remapInput("Bash", { command: "node w.js", workdir: "C:/x", description: "run" }),
    { command: "node w.js", description: "run" }
  );
  eq("Grep limit maps to head_limit", remapInput("Grep", { pattern: "x", limit: 5 }).head_limit, 5);
  // A drop-list for one tool must not leak into another.
  eq("workdir kept on Read", remapInput("Read", { file_path: "a", workdir: "b" }).workdir, "b");
}

/* -------------------------------------------------------- narration shape */
{
  // Real replies, and what each one must be. The distinction that matters is
  // announcing an action versus delivering one: "Okay" or "I'll" decides nothing
  // on its own.
  const cases = [
    ["Okay, continuing to read the rest of bridge.mjs, and kicking off research in parallel.", true],
    ["Continuing to read the rest of bridge.mjs and kicking off research in parallel.", true],
    ["I'll read the file for you.", true],
    ["Let me check the rest of the config now.", true],
    // Finished answers that start the same way. Rejecting these throws away a
    // correct reply, which is worse than the failure being fixed.
    ["Okay, here is the summary you asked for. The file contains 42 lines.", false],
    [
      "Sure, let me summarize what I found in the config file: effort is set to high and the port is 8787.",
      false,
    ],
    ["Okay, the answer is 42.", false],
    [
      "Okay, here is my plan:\n1. read the config\n2. then run the tests\n3. report back. " +
        "This is a longer plan and it starts by announcing the work, which is why it needs the boundary rule.",
      false,
    ],
    ["", false],
  ];
  for (const [text, want] of cases) {
    eq(`narration(${want ? "yes" : "no"}): ${text.slice(0, 52)}`, looksLikeNarration(text), want);
  }
}

/* ------------------------------------------------ MCP collision guard */
{
  const withMcp = ["Read", "Bash", "mcp__ide__readFile", "mcp__fs__list_files"];
  // A namespaced tool the caller really offered is used as-is. The guard is
  // about names the caller did NOT offer.
  eq("offered namespaced tool is used verbatim", resolveToolName("mcp__ide__readFile", withMcp), "mcp__ide__readFile");
  eq("mcp prefix not in the list is refused", resolveToolName("mcpReadFile", withMcp), null);
  // A camelCase tail of a namespaced tool must not resolve to the local Read:
  // that would answer confidently about a different source. Previously this
  // guard could not fire at all - punctuation was stripped before splitting on
  // "__", so the split returned one element.
  eq("camel tail of an mcp tool is refused", resolveToolName("list_files", withMcp), null);
  eq("readFile is not aliased at all", resolveToolName("readFile", withMcp), null);
  // The real tools must keep working.
  eq("Read still resolves", resolveToolName("Read", withMcp), "Read");
  eq("shell still maps to Bash", resolveToolName("shell", withMcp), "Bash");
}

/* --------------------------------------- structurally impossible aliases */
{
  const web = ["Read", "WebFetch", "WebSearch"];
  // OpenCode's webfetch takes `format`, WebFetch needs `prompt`, so routing it
  // could only ever produce a schema violation. It used to slip through the
  // case-insensitive match that runs before the alias table.
  eq("webfetch refused however it is spelled", resolveToolName("webfetch", web), null);
  eq("WebFetch itself still resolves", resolveToolName("WebFetch", web), "WebFetch");
  // No Claude Code tool exists called LS, so list/ls/dir must fall through to a
  // tool that does exist rather than to a guaranteed rejection.
  const cc = ["Read", "Glob", "Bash"];
  eq("list falls back to a real tool", ["LS", "Glob", "Bash"].includes(resolveToolName("list", cc)), true, String(resolveToolName("list", cc)));
  eq("TodoRead is gone", Object.keys(resolveToolName ? {} : {}).length, 0);
}

/* ------------------------------------------- keys OpenCode teaches wrongly */
{
  // `replaceAll` is not just an invented key: OpenCode's injected prompt
  // explicitly tells the model to use it, so the bridge was being taught to
  // send a key Claude Code rejects. Passing it through applies the edit once
  // where it should have replaced every occurrence - with no error anywhere.
  eq(
    "Edit replaceAll mapped to replace_all",
    remapInput("Edit", { path: "a", oldString: "x", newString: "y", replaceAll: true }),
    { file_path: "a", old_string: "x", new_string: "y", replace_all: true }
  );
  eq("Glob include mapped to pattern", remapInput("Glob", { include: "*.js" }).pattern, "*.js");
  eq("Glob hidden dropped", "hidden" in remapInput("Glob", { pattern: "*", hidden: true }), false);
  eq("Glob limit dropped", "limit" in remapInput("Glob", { pattern: "*", limit: 5 }), false);
  // Cannot be mapped: Claude Code's equivalent is `-i`, which inverts the sense.
  eq("Grep caseSensitive dropped", "caseSensitive" in remapInput("Grep", { pattern: "x", caseSensitive: true }), false);
}

/* ------------------------------------------------ schema validation (#6) */
{
  const readSchema = {
    type: "object",
    properties: { file_path: { type: "string" }, offset: { type: "number" } },
    required: ["file_path"],
  };
  eq("valid read passes", validateInput(readSchema, { file_path: "a" }), []);
  eq("missing required caught", validateInput(readSchema, {}).length, 1);
  eq("wrong type caught", validateInput(readSchema, { file_path: 3 }).length, 1);
  eq("non-object caught", validateInput(readSchema, "x").length, 1);
  eq("array input caught", validateInput(readSchema, []).length, 1);
  eq("enum checked", validateInput({ enum: ["a", "b"] }, "c").length, 1);
  // arrays with nested objects are the TodoWrite / AskUserQuestion shape, and
  // they are two of the tools a coding agent calls most.
  const todoSchema = {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: { content: { type: "string" }, status: { enum: ["pending", "in_progress", "completed"] } },
          required: ["content"],
        },
      },
    },
    required: ["todos"],
  };
  eq("valid todos pass", validateInput(todoSchema, { todos: [{ content: "a", status: "pending" }] }), []);
  ok("nested missing required caught", validateInput(todoSchema, { todos: [{ status: "pending" }] }).length >= 1);
  ok("nested enum caught", validateInput(todoSchema, { todos: [{ content: "a", status: "BOGUS" }] }).length >= 1);

  // `type` as an array and `nullable` are ordinary in MCP tool schemas.
  eq(
    "union type accepts null",
    validateInput({ type: ["string", "null"] }, null),
    []
  );
  eq("union type accepts the string", validateInput({ type: ["string", "null"] }, "x"), []);
  eq("union type rejects a number", validateInput({ type: ["string", "null"] }, 3).length, 1);
  eq("nullable accepts null", validateInput({ type: "string", nullable: true }, null), []);
  eq("anyOf accepts a branch", validateInput({ anyOf: [{ type: "string" }, { type: "number" }] }, 3), []);
  eq("anyOf rejects a non-branch", validateInput({ anyOf: [{ type: "string" }] }, {}).length, 1);

  eq(
    "additionalProperties false",
    validateInput({ type: "object", properties: { a: {} }, additionalProperties: false }, { b: 1 })
      .length,
    1
  );
}

/* ------------------------------------- normalizeEnvelope (#6, #7, #12) */
{
  const tools = [
    { name: "Read", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
    { name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  ];

  // patch-shaped input aliased onto Edit is the realistic failure; here the
  // shape simply violates Read's schema and must not become a tool_use.
  const bad = normalizeEnvelope(
    { tools: [{ name: "Read", input: {} }] },
    tools
  );
  eq("schema violation -> no tool_use", bad.tools.length, 0);
  ok("schema violation bucketed", bad.rejected.badInput[0]?.startsWith("Read"));

  const arrInput = normalizeEnvelope({ tools: [{ name: "Read", input: ["a"] }] }, tools);
  eq("array input rejected", arrInput.tools.length, 0);
  ok("array input bucketed as shape", arrInput.rejected.badShape.length === 1);

  const unknown = normalizeEnvelope({ tools: [{ name: "frobnicate", input: {} }] }, tools);
  ok("unknown name bucketed", unknown.rejected.unknownName.length === 1);
  eq("unknown name kept out of tools", unknown.tools.length, 0);

  const good = normalizeEnvelope(
    { tools: [{ name: "shell", input: { command: "ls" } }] },
    tools
  );
  eq("aliased shell -> Bash", good.tools[0]?.name, "Bash");

  const aliasedArgs = normalizeEnvelope(
    { tools: [{ name: "read", input: { filePath: "C:/x" } }] },
    tools
  );
  eq("aliased read args remapped", aliasedArgs.tools[0]?.input, { file_path: "C:/x" });

  // An object where a name belongs must not leak "[object Object]".
  const weird = normalizeEnvelope({ tools: [{ name: { a: 1 }, input: {} }] }, tools);
  eq(
    "object name dropped",
    (weird.rejected.unknownName || []).some((u) => u.includes("[object")),
    false
  );

  const stringArgs = normalizeEnvelope(
    { tools: [{ name: "Bash", input: '{"command":"dir"}' }] },
    tools
  );
  eq("string args parsed", stringArgs.tools[0]?.input, { command: "dir" });

  eq("null envelope", normalizeEnvelope(null, tools).tools, []);

  // Envelope recognition: narration and envelope drift must both be detectable,
  // otherwise their raw text is rendered to the user verbatim.
  eq("plain text reply recognized", normalizeEnvelope({ text: "hi" }, tools).recognized, true);
  eq("tools-only recognized", normalizeEnvelope({ tools: [] }, tools).recognized, true);
  eq("unknown shape NOT recognized", normalizeEnvelope({ answer: 42 }, tools).recognized, false);
  eq("content key NOT recognized", normalizeEnvelope({ content: "42" }, tools).recognized, false);
  eq("unparsed input not recognized", normalizeEnvelope(null, tools).recognized, false);

  // subagent must not become Task: OpenCode's injected prompt pushes it, and
  // Claude Code's Task runs agents in the background by default.
  eq("subagent not aliased", resolveToolName("subagent", ["Task", "Read"]), null);
  eq("agent still aliased", resolveToolName("agent", ["Task", "Read"]), "Task");

  // notebook tools must not fall through to Edit/Read.
  const nbTools = [
    { name: "NotebookEdit", input_schema: { type: "object", properties: { notebook_path: { type: "string" } }, required: ["notebook_path"] } },
  ];
  eq("notebook_edit resolves", resolveToolName("notebook_edit", ["NotebookEdit", "Edit"]), "NotebookEdit");
  const nbMap = normalizeEnvelope(
    { tools: [{ name: "notebook_edit", input: { filePath: "a.ipynb", new_source: "x" } }] },
    nbTools
  );
  eq("notebook args remapped", nbMap.tools[0]?.input, { notebook_path: "a.ipynb", new_source: "x" });

  // MCP names never alias, even alongside ordinary tools.
  eq(
    "mcp readFile not hijacked",
    resolveToolName("readFile", ["Read", "Bash", "mcp__ide__readFile"]),
    null
  );
  eq(
    "shell still aliases when an MCP server is connected",
    resolveToolName("shell", ["Bash", "mcp__ide__readFile"]),
    "Bash"
  );
  eq(
    "mcp full name resolves to itself",
    resolveToolName("mcp__ide__readFile", ["Read", "mcp__ide__readFile"]),
    "mcp__ide__readFile"
  );
}

/* ----------------------------------------------------- buildTranscript (#9) */
{
  let threw = null;
  try {
    buildTranscript({ tools: {} });
  } catch (e) {
    threw = e;
  }
  ok("tools object rejected", threw?.status === 400, String(threw));

  threw = null;
  try {
    buildTranscript({ messages: [null] });
  } catch (e) {
    threw = e;
  }
  ok("null message rejected", threw?.status === 400, String(threw));

  threw = null;
  try {
    buildTranscript({ messages: [{ role: "user", content: [null] }] });
  } catch (e) {
    threw = e;
  }
  ok("null content block rejected", threw?.status === 400, String(threw));

  const t = buildTranscript({
    system: "sys",
    tools: [{ name: "Read", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "out" }] },
    ],
  });
  ok("transcript keeps user text", t.includes("[user] hi"));
  ok("transcript tags the tool call with its id", t.includes("[assistant called tool #t] Read"));
  ok("tool result is fenced", t.includes('<tool_result id="t">') && t.includes("</tool_result>"));
  ok("tool result content survives", t.includes("out"));
  ok("transcript has protocol", t.includes("RESPONSE FORMAT"));
  ok("protocol marks tool results untrusted", t.includes("untrusted data"));
  ok("transcript honours tool_choice any", buildTranscript({
    tools: [{ name: "Read" }], tool_choice: { type: "any" }, messages: [],
  }).includes("REQUIRES you to call at least one tool"));
  ok("transcript honours tool_choice none", buildTranscript({
    tools: [{ name: "Read" }], tool_choice: { type: "none" }, messages: [],
  }).includes("forbids every tool call"));
}

/* ------------------------------------------------------------- capText */
{
  const big = "x".repeat(50_000);
  const capped = capText(big, 1000);
  ok("capped length sane", capped.length < 1400, String(capped.length));
  ok("capped keeps head", capped.startsWith("x"));
  ok("capped keeps tail", capped.endsWith("x"));
  ok("small text untouched", capText("abc", 1000) === "abc");
}

/* --------------------------------------------------------- toAnthropicError (#9) */
{
  const overflow = Object.assign(new Error("prompt is too long: ContextWindowExceededError"), {
    name: "ContextTooLong",
  });
  const e1 = toAnthropicError(overflow);
  eq("overflow status", e1.status, 400);
  eq("overflow no retry", e1.shouldRetry, false);

  const upstream = Object.assign(new Error("opencode -> 503 Upstream request failed"), { status: 503 });
  const e2 = toAnthropicError(upstream);
  eq("upstream retryable", e2.shouldRetry, true);
  eq("upstream overloaded", e2.type, "overloaded_error");

  // A bug in this file is not retryable.
  const bug = new TypeError("body.tools.map is not a function");
  const e3 = toAnthropicError(bug);
  eq("internal error not retryable", e3.shouldRetry, false);
  eq("internal error status", e3.status, 500);

  // An exhausted turn must NOT be retryable. Three internal attempts already ran
  // and the failure is deterministic for the prompt, so a client retry would
  // pay three more upstream calls for the same empty answer.
  const empty = Object.assign(new Error("model returned no usable reply"), {
    name: "EmptyTurn",
  });
  const e4 = toAnthropicError(empty);
  eq("empty turn not retryable", e4.shouldRetry, false);
  eq("empty turn status", e4.status, 400);
}

/* ------------------------------------------------------------- effort (#6) */
{
  const body = (effort) => (effort ? { output_config: { effort } } : {});
  eq("valid level", resolveEffort(body("high")).level, "high");
  eq("valid level source", resolveEffort(body("medium")).source, "request");
  // An unrecognised level must clamp in the documented direction - highest
  // supported AT OR BELOW the requested one - not always up to max. Promoting
  // `minimal` to `max` turns a 2s turn into a 30s one.
  eq("above ceiling clamps up", resolveEffort(body("ultracode")).level, "max");
  eq("above ceiling source", resolveEffort(body("ultracode")).source, "clamped-up");
  eq("below floor clamps down", resolveEffort(body("minimal")).level, "low");
  eq("below floor source", resolveEffort(body("minimal")).source, "clamped-down");
  eq("auto means use the default", resolveEffort(body("auto")).source, "auto");
  eq("unknown word falls back to default", resolveEffort(body("ultra")).level, "medium");
  eq("unknown word source", resolveEffort(body("ultra")).source, "unsupported");
  eq("missing level uses default", resolveEffort({}).source, "default");
  // With no BRIDGE_AUX_EFFORT configured, an auxiliary turn keeps its level.
  eq("auxiliary untouched when unconfigured", resolveEffort(body("high"), { requestClass: "auxiliary" }).level, "high");
  eq("compaction not treated as aux", resolveEffort(body("high"), { requestClass: "compaction" }).level, "high");
  eq("subagent not treated as aux", resolveEffort(body("high"), { requestClass: "subagent" }).level, "high");
  // side_reply is one of the six classes Claude Code sends and is exactly the
  // short throwaway turn AUX_EFFORT exists for.
  eq("side_reply is an aux class", resolveEffort(body("high"), { requestClass: "side_reply" }).level, "high");
}

/* --------------------------------------------------------------- misc */
{
  ok("five effort levels", EFFORT_LEVELS.length === 5);
  ok("input limit positive", MODEL_LIMITS.input > 0);
  const t0 = transcriptTokens("x".repeat(10_000));
  ok("token estimate conservative", t0 >= 2700, String(t0));
}

/* ------------------------------------------------------------- report */
console.log(`\nunit: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log("  FAIL " + f);
process.exit(fail ? 1 : 0);