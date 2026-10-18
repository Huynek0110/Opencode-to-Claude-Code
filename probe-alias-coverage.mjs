/**
 * Coverage matrix: for every tool name OpenCode advertises, does it resolve when
 * the matching Claude Code tool is on offer? Zero token cost - pure functions.
 */
import { resolveToolName } from "./bridge.mjs";

// What OpenCode actually registers, from its own tool descriptions in the binary
// and the names its injected prompt uses.
const OPENCODE_NAMES = [
  "read", "write", "edit", "grep", "glob", "shell", "bash", "patch",
  "todowrite", "todoread", "webfetch", "websearch", "subagent", "task",
  "skill", "question", "list", "ls", "dir", "cat", "find", "search", "run",
];

// Claude Code's real tool set, from the installed artifact on this machine
// (sdk-tools.d.ts) as catalogued in RESEARCH-tool-call.md. NOT a guess: a
// previous version of this file guessed, and the guess was wrong about LS.
const CLAUDE_CODE = [
  "Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS",
  "NotebookRead", "NotebookEdit", "Cd", "Task", "TodoWrite",
  "WebFetch", "WebSearch", "AskUserQuestion", "Skill", "SlashCommand",
  "EnterPlanMode", "ExitPlanMode", "TaskCreate", "TaskUpdate", "TaskOutput",
  "TaskStop", "KillBash", "KillShell",
];

const rows = [];
for (const name of OPENCODE_NAMES) {
  const hit = resolveToolName(name, CLAUDE_CODE);
  rows.push({ name, hit });
}

const unresolved = rows.filter((r) => !r.hit);
const resolved = rows.filter((r) => r.hit);

console.log(`OpenCode names: ${OPENCODE_NAMES.length}`);
console.log(`resolved      : ${resolved.length}`);
console.log(`unresolved    : ${unresolved.length}`);
console.log("");
console.log("UNRESOLVED (each costs one retry whenever the model uses it):");
for (const r of unresolved) console.log("  " + r.name);

console.log("\nRESOLVED:");
for (const r of resolved) console.log(`  ${r.name.padEnd(12)} -> ${r.hit}`);

// What does Claude Code offer that nothing maps onto?
const mappedTargets = new Set(resolved.map((r) => r.hit));
const orphanTargets = CLAUDE_CODE.filter((t) => !mappedTargets.has(t));
console.log(`\nClaude Code tools with no OpenCode name mapped onto them (${orphanTargets.length}):`);
console.log("  " + orphanTargets.join(", "));