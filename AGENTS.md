# AGENTS.md — working rules for this repository

Read this before running anything. The constraint below is not a preference; it
is the main reason this file exists.

## NEVER run anything that calls the model

The model behind this bridge is a free tier with a hard rate limit, and it is
currently being throttled continuously. A single `claude -p` turn costs about
**32 000 input tokens** — 23 tool schemas plus the Claude Code system prompt.
That is enough to exhaust the quota on its own.

### Forbidden

```
claude -p  (any form, including via claude-bridge.ps1)
node probe-toolcall.mjs
node probe-behaviour.mjs
powershell -File .\start-bridge.ps1      <-- probes a real completion when it starts something
powershell -File .\run-tests.ps1 -Live  <-- and every -LiveCount suite
node test-load.mjs
node test-effort.mjs
node test-protocol.mjs
node test-sse.mjs
node test-bridge.mjs
```

Also forbidden: `POST /api/session/{id}/generate` and `/prompt` with a real
prompt, from curl, from a script, or from anything else.

`start-bridge.ps1` is the trap that looks harmless. It is documented as
idempotent and re-checks health, but it posts a real completion when it starts
anything, and a rate limit then reports itself as a configuration failure.

### Allowed — zero token

```
node test-unit.mjs            170 assertions, imports the pure functions
node test-http.mjs             47 assertions, drives DeferredSSE against a fake response
node test-mock.mjs            116 assertions, spawns a FAKE opencode serve
node --check <file>
node probe-alias-coverage.mjs  pure functions
powershell -File .\run-tests.ps1        no -Live: runs only the three above
```

The runner prints the real total (333) because it parses each suite's count.
It used to print a hardcoded 281 that stayed wrong while the suites grew — which
is part of why the prompt going untested went unnoticed. Do not hardcode it again.

`test-mock.mjs` is not a loophole: it stands up its own mock upstream and points
a real `bridge.mjs` child process at it, so no provider is ever contacted. If a
suite needs a provider, it is a live suite and it is forbidden.

Also free: `GET /health`, `GET /effort`, `GET /debug/sessions`, `GET /v1/models`,
`GET /openapi.json`, `GET /api/agent`, `GET /api/config`, and
`POST /api/session/{id}/permission` — that last one evaluates permission rules
without generating anything.

## Measuring the model, when it is explicitly allowed

Only with the user's say-so, and only `node probe-toolcall.mjs 5` — four cases,
about 1 500 input tokens, against roughly 128 000 for the same four through
`claude -p`. Nothing else is proportionate.

## What "done" means here

Contracts live in `test-mock.mjs` and are free. Anything that needs the real
model is measured by a probe that reports rather than asserts: a free model may
behave differently on a different day, and a suite that fails for that reason
teaches you to ignore the suite.

Do not claim the model can use tool call without a measurement that says so.
"Implemented" and "the model uses it" are different claims, and conflating them
was a real mistake here.

**Update:** the measurement exists, in `bridge.log`, from 2026-10-18. Two real
tool calls, one of them on the first attempt. See `EVIDENCE-model-toolcall.md`.
Read it before claiming anything is unproven — and note it predates the current
prompt, so the shipping contract is still unmeasured.

## Editing while someone else is reading

If a subagent or another process is reading the repository, do not edit the
files it is reading. Its report then describes code that no longer exists, and
every finding has to be re-checked. Group the edits and apply them between
rounds.

The subtler version of that trap is `git add -A`. A reviewer running mutation
tests **must** temporarily break the source, and `git status` then shows those
in-flight mutations as ordinary edits. Committing them ships a knowingly broken
version. It happened here: commit `e9766ac` captured a reviewer's live mutation
of `renderToolResult` and lost `escapeFence` on the JSON fallback path.

While any agent is running:

- Never `git add -A` and never `git commit -a`. Stage by explicit path.
- A `git diff` on a file you did not just edit means someone else is mid-edit.
- Do not "fix" a surprising working-tree diff. It is probably deliberate and
  temporary; reverting it out from under the agent corrupts its measurement.
- Check `git diff` after any agent finishes, before you trust its report.