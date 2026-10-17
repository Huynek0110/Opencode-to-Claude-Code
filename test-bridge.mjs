#!/usr/bin/env node
/**
 * End-to-end check for the bridge. Not part of the runtime.
 *   node test-bridge.mjs
 */
const BRIDGE = process.env.BRIDGE_URL || "http://127.0.0.1:8787";

const READ_TOOL = {
  name: "Read",
  description: "Read a file from the local filesystem.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "absolute path" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    required: ["file_path"],
  },
};

async function call(body) {
  const r = await fetch(BRIDGE + "/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

const system = `You are Claude Code, an interactive CLI tool that helps users with software engineering tasks.
Use the Read tool to read files. Always read a file before editing it.`;

(async () => {
  // 1. plain text
  let { status, json } = await call({
    model: "space-bunny-free",
    max_tokens: 1024,
    system,
    tools: [READ_TOOL],
    messages: [{ role: "user", content: "Say hello in one short sentence. Do not call any tool." }],
  });
  console.log("TEST 1 status", status);
  console.log(JSON.stringify(json, null, 2).slice(0, 1200));

  // 2. tool call
  ({ status, json } = await call({
    model: "space-bunny-free",
    max_tokens: 2048,
    system,
    tools: [READ_TOOL],
    messages: [
      {
        role: "user",
        content: "Read the file C:\\Users\\Le Hung Lam\\Desktop\\claude-code-bridge\\README.md and tell me what it is.",
      },
    ],
  }));
  console.log("\nTEST 2 status", status);
  console.log(JSON.stringify(json, null, 2).slice(0, 2000));

  // 3. tool result round trip
  if (json?.content?.some((b) => b.type === "tool_use")) {
    const call_ = json.content.find((b) => b.type === "tool_use");
    ({ status, json } = await call({
      model: "space-bunny-free",
      max_tokens: 1024,
      system,
      tools: [READ_TOOL],
      messages: [
        {
          role: "user",
          content: "Read the file C:\\Users\\Le Hung Lam\\Desktop\\claude-code-bridge\\README.md and tell me what it is.",
        },
        { role: "assistant", content: json.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: call_.id,
              content: "# claude-code-bridge\n\nA bridge between Claude Code and OpenCode.",
            },
          ],
        },
      ],
    }));
    console.log("\nTEST 3 status", status);
    console.log(JSON.stringify(json, null, 2).slice(0, 2000));
  }

  // 4. streaming
  const r = await fetch(BRIDGE + "/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "space-bunny-free",
      max_tokens: 256,
      stream: true,
      system,
      messages: [{ role: "user", content: "Count: 1 2 3. Just confirm." }],
    }),
  });
  const text = await r.text();
  console.log("\nTEST 4 stream status", r.status);
  console.log(text.slice(0, 900));
})();