#!/usr/bin/env node
/** Verify effort plumbing: request field, default, lock, and control endpoint. */
const BRIDGE = "http://127.0.0.1:8787";

const SYSTEM = "You are Claude Code, a CLI coding assistant.";

async function call(body) {
  const t0 = Date.now();
  const r = await fetch(BRIDGE + "/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "space-bunny-free", max_tokens: 512, system: SYSTEM, ...body }),
  });
  const j = await r.json();
  return {
    ms: Date.now() - t0,
    header: r.headers.get("x-bridge-effort"),
    source: r.headers.get("x-bridge-effort-source"),
    text: (j.content || []).map((c) => c.text || "").join(""),
    stop: j.stop_reason,
    output: Number(j.usage?.output_tokens || 0),
    input: Number(j.usage?.input_tokens || 0),
  };
}

const Q = "What is 17 * 23? Think it through, then reply with only the final number.";
let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`);
  }
};

(async () => {
  // This test mutates the bridge's persisted default. Two things matter:
  // put it back even when the run aborts, and do not trust what the last run
  // left on disk. `process.on("exit")` could not do this - an exit handler runs
  // synchronously and the fetch it started is killed with the process, so the
  // restore silently never happened and the next run failed on stale state.
  const setDefault = (effort) =>
    fetch(BRIDGE + "/effort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effort }),
    });

  await setDefault("medium");

  try {
    const dflt = await call({ messages: [{ role: "user", content: Q }] });
    console.log("default:", JSON.stringify(dflt));
    check("default uses bridge default", dflt.header === "medium", dflt.header);

  for (const level of ["low", "high", "max"]) {
    const r = await call({
      output_config: { effort: level },
      messages: [{ role: "user", content: Q }],
    });
    console.log(`output_config.effort=${level.padEnd(6)}`, `-> used=${r.header} src=${r.source} (${r.ms}ms)`, r.text);
    check(`effort ${level} honoured`, r.header === level, r.header);
    check(`effort ${level} source is request`, r.source === "request", r.source);
  }

  const bogus = await call({
    output_config: { effort: "ultracode" },
    messages: [{ role: "user", content: "hi" }],
  });
  console.log("above ceiling ->", bogus.header, bogus.source);
  check("above ceiling clamps up to max", bogus.header === "max", bogus.header);
  check("above ceiling marked clamped-up", bogus.source === "clamped-up", bogus.source);

  const below = await call({
    output_config: { effort: "minimal" },
    messages: [{ role: "user", content: "hi" }],
  });
  console.log("below floor ->", below.header, below.source);
  check("below floor clamps down to low", below.header === "low", below.header);
  check("below floor marked clamped-down", below.source === "clamped-down", below.source);

  const auto = await call({
    output_config: { effort: "auto" },
    messages: [{ role: "user", content: "hi" }],
  });
  console.log("auto ->", auto.header, auto.source);
  check("auto uses the default", auto.source === "auto", auto.source);

  console.log("\ncontrol endpoint:");
  for (const level of ["high", "low", "medium"]) {
    const r = await fetch(BRIDGE + "/effort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effort: level }),
    });
    const j = await r.json();
    console.log("  set", level, "->", j.effort);
    check(`effort endpoint set ${level}`, j.effort === level, j.effort);
  }
  const after = await call({ messages: [{ role: "user", content: Q }] });
  console.log("  request with no effort now uses:", after.header);
  check("default restored after endpoint writes", after.header === "medium", after.header);

  const bad = await fetch(BRIDGE + "/effort", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ effort: "nope" }),
  });
  const badJson = await bad.json();
  console.log("  invalid level ->", bad.status, JSON.stringify(badJson));
  check("invalid effort rejected", bad.status === 400, String(bad.status));

  // max_tokens ceiling
  const short = await call({
    max_tokens: 3,
    messages: [{ role: "user", content: "Write a 200 word essay about the sea." }],
  });
  console.log("\nmax_tokens=3 ->", short.stop, "text len", short.text.length, JSON.stringify(short.text));
  check("max_tokens stop_reason", short.stop === "max_tokens", short.stop);
  // Reported output has to describe what was sent, not what was discarded.
  check(
    "reported output_tokens matches the truncated text",
    short.output <= Math.max(3, Math.ceil(short.text.length / 2.8) + 1),
    `output=${short.output} for ${short.text.length} chars`
  );

  console.log(`\neffort: ${pass} passed, ${fail} failed`);
  } finally {
    await setDefault("medium");
  }
  process.exit(fail ? 1 : 0);
})();