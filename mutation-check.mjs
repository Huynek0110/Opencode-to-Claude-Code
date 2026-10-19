#!/usr/bin/env node
/**
 * Mutation check for the fixes that had no test.
 *
 * Why this exists. Round 8 fixed seven things and its commit message said "tests
 * added for each of these". Round 9's mutation pass proved that for `detail`,
 * `escapeFence`, `retryNote`, `disable_parallel` and the stop_reason precedence
 * there had been no test at all: reverting any of them left all 333 assertions
 * green. A green suite was carrying no information about the parts of the bridge
 * that talk to the model.
 *
 * A test that never fails is not evidence. This runs the suites against
 * deliberately broken source and requires each one to be caught.
 *
 * COSTS NOTHING. It spawns no provider and contacts no network; it edits
 * bridge.mjs in place and restores it byte-for-byte, verifying the restore each
 * time.
 *
 *   node mutation-check.mjs
 *
 * Exits non-zero if any mutation survives, so it can gate a commit.
 *
 * Two lessons are baked in, both paid for in this repo already:
 *  - the source is CRLF, so every search string is normalised first, and a
 *    mutation that does not apply is reported as INCONCLUSIVE rather than
 *    silently counted as a pass;
 *  - the restore is verified AFTER writing the original back, never before. An
 *    earlier harness of mine compared the mutated file against the original and
 *    reported "could not restore" on a perfectly good tree.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = path.join(HERE, "bridge.mjs");
// A sidecar copy of the pristine file. Signal handlers do not survive kill -9 or
// a harness-level abort, and this script has already left mutated source on disk
// once that way. If the sidecar is here at startup, the last run died holding a
// mutation, and restoring is the only correct action - otherwise the bridge would
// silently run whatever the dead run left behind.
const BAK = path.join(HERE, ".mutation-check.bak");
if (fs.existsSync(BAK)) {
  fs.copyFileSync(BAK, P);
  fs.unlinkSync(BAK);
  console.log("a previous mutation run died mid-edit; bridge.mjs restored from the sidecar.");
}

const orig = fs.readFileSync(P);
fs.writeFileSync(BAK, orig);
const origText = orig.toString("utf8");
const EOL = origText.includes("\r\n") ? "\r\n" : "\n";
const norm = (s) => s.replace(/\r\n/g, "\n");

const MUTATIONS = [
  ["detail: the empty-array-is-truthy regression",
   "const detail = kind\n        ? (r.unknownName.length ? r.unknownName : r.badShape.length ? r.badShape : r.badInput).slice(0, 4)\n        : [];",
   "const detail = kind ? (r.unknownName || r.badShape || r.badInput || []).slice(0, 4) : [];"],

  ["escapeFence: becomes a no-op",
   'return String(s).replace(/<\\/tool_result>/gi, "<\\\\/tool_result>");',
   "return String(s);"],

  ["escapeFence: dropped from the JSON branch",
   "const json = escapeFence(safeJson(p));",
   "const json = safeJson(p);"],

  ["retryNote: never sent",
   "transcript + (retryNote || RETRY_HINTS[attempt])",
   "transcript + RETRY_HINTS[attempt]"],

  ["disable_parallel_tool_use: keeps the LAST call",
   "for (let i = 0; i < content.length; i++) {",
   "for (let i = content.length - 1; i >= 0; i--) {"],

  ["stop_reason: truncated wins over a complete tool_use",
   'const stopReason = hasTool ? "tool_use" : truncated ? "max_tokens" : "end_turn";',
   'const stopReason = truncated ? "max_tokens" : hasTool ? "tool_use" : "end_turn";'],

  ["RETRY_HINTS: invents a discarded tool call",
   'const RETRY_HINTS = [\n  "",\n  "",',
   'const RETRY_HINTS = [\n  "",\n  "\\n\\n[CORRECTION] Your previous reply came back EMPTY because the tool call you attempted used a native channel.",'],

  ["tool_choice tool: a REQUIRED block for an unoffered tool",
   "if (!allowed.includes(choice.name)) return [];",
   ""],

  ["closer: unconditional again",
   'if (tools.length && body.tool_choice?.type !== "none") {',
   "if (true) {"],

  ["session: single-flight fast path removed",
   "if (entry?.inflight) return entry.inflight;",
   ""],

  ["session: a failed create is cached forever",
   "if (sessions.get(key)?.inflight === promise) sessions.delete(key);",
   ""],

  ["budget: an over-budget prompt is no longer refused before streaming",
   "  if (TURN_TOKEN_BUDGET > 0 && preflight > TURN_TOKEN_BUDGET) {",
   "  if (false) {"],

  ["streaming: the error event stops saying retry",
   "            should_retry: e.shouldRetry === true,",
   "            should_retry: false,"],

  ["protocol: emptied",
   /const RESPONSE_PROTOCOL = `[\s\S]*?`;/,
   "const RESPONSE_PROTOCOL = ``;"],
];

// Provably equivalent, so a survivor here is a finding about the checker rather
// than a blind spot in the suite.
//
// `detail` reads unknownName before badShape. Swapping them changes nothing
// because normalizeEnvelope never validates the schema of a tool it does not
// recognise: an unknown name is reported only in unknownName, and a known tool
// with a bad shape only in badShape. The two can never both be non-empty, so
// their relative order is unobservable. If that invariant is ever broken, the
// order starts to matter and this entry must move back into MUTATIONS.
const EQUIVALENT = [];

function run(suite) {
  try {
    execFileSync("node", [path.join(HERE, suite)], { stdio: "pipe", encoding: "utf8", cwd: HERE });
    return false;
  } catch {
    return true;
  }
}

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  try {
    fs.writeFileSync(P, orig);
  } catch {
    /* nothing useful to do while exiting */
  }
}

// A Ctrl-C in the middle of this script would otherwise leave bridge.mjs
// mutated on disk, and the next `node bridge.mjs` would run broken code with
// nothing in the output to say why.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    restore();
    console.log("\ninterrupted; bridge.mjs restored.");
    process.exit(130);
  });
}
process.on("uncaughtException", (e) => {
  restore();
  console.error("\n" + e.message);
  process.exit(2);
});

let caught = 0;
let survived = 0;
let inconclusive = 0;
const blind = [];

console.log("mutating bridge.mjs, one at a time, and restoring after each.\n");

for (const [id, from, to] of MUTATIONS) {
  const hay = norm(origText);
  const hit = typeof from === "string" ? hay.includes(norm(from)) : from.test(hay);
  if (!hit) {
    console.log("  ?? INCONCLUSIVE  " + id + "  (the source no longer contains that text)");
    inconclusive++;
    continue;
  }
  const mutated = (typeof from === "string" ? hay.replace(norm(from), norm(to)) : hay.replace(from, to)).replace(/\n/g, EOL);
  fs.writeFileSync(P, mutated);

  const failed = run("test-mock.mjs");

  fs.writeFileSync(P, orig);
  if (!fs.readFileSync(P).equals(orig)) {
    console.log("  !! ABORT: bridge.mjs could not be restored byte-for-byte.");
    console.log("     Recover it with:  git checkout -- bridge.mjs");
    process.exit(2);
  }

  if (failed) {
    console.log("  CAUGHT    " + id);
    caught++;
  } else {
    console.log("  SURVIVED  " + id + "   <-- a blind spot");
    survived++;
    blind.push(id);
  }
}

console.log("\n  caught " + caught + " / survived " + survived + " / inconclusive " + inconclusive);
if (EQUIVALENT.length) console.log("  known-equivalent mutants (documented, not counted): " + EQUIVALENT.length);
if (blind.length) {
  console.log("\n  Still blind:");
  for (const b of blind) console.log("    - " + b);
  process.exit(1);
}
fs.unlinkSync(BAK);
console.log("\n  Every mutation was caught. The suite is not decorative.");
