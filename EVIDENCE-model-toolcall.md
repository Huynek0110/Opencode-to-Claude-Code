# Evidence: has this model ever emitted a usable tool call?

**Yes. Twice, in real traffic, on 2026-10-18. One of them on the first attempt.**

This file exists because the answer had been recorded as "unproven" for several
rounds while `bridge.log` sat in the repository holding the proof. It was found
by reading the log instead of trying to spend a token.

## What the log contains

From `bridge.log`, the three completed requests that match
`probe-toolcall.mjs`'s signature exactly (`tools: 3`, `messages: 1`,
`max_tokens: 2048`):

```json
{"kind":"start","id":"req_mvegijcm0005ly6x4a","max_tokens":2048,"tools":3,"messages":1,"prompt_tokens":1240}
{"kind":"done","id":"req_mvegijcm0005ly6x4a","attempts":2,"ms":27603,"chars":72,
 "tokens_spent":2695,"calls":["Read"],"rejected":{"unknownName":[],"badInput":[],"badShape":[]},"stop":"tool_use"}

{"kind":"start","id":"req_mvegj5lm0009qw8mrg","max_tokens":2048,"tools":3,"messages":1,"prompt_tokens":1244}
{"kind":"done","id":"req_mvegj5lm0009qw8mrg","attempts":1,"ms":15735,"chars":126,
 "tokens_spent":1244,"calls":["Bash"],"rejected":{"unknownName":[],"badInput":[],"badShape":[]},"stop":"tool_use"}

{"kind":"start","id":"req_mvegjioo000dq0agpe","max_tokens":2048,"tools":3,"messages":1,"prompt_tokens":1240}
{"kind":"error","id":"req_mvegjioo000dq0agpe","status":499,"type":"request_canceled"}
```

Case order in the probe is `read`, `run`, `write`, `answer`. So:

| case | outcome | evidence |
| --- | --- | --- |
| `read` | **tool call emitted and converted** | `calls:["Read"]`, `stop:"tool_use"`, 2 attempts |
| `run` | **tool call emitted and converted** | `calls:["Bash"]`, `stop:"tool_use"`, **1 attempt** |
| `write` | unknown | `seq` 1-3 rotated out of the log head |
| `answer` | client aborted | 499 `request_canceled` - the client hung up, not a model failure |

## Why this is real traffic and not the mock

The mock writes to `bridge.mock.log` and answers in single-digit milliseconds.
`bridge.mock.log` tail confirms it: `ms: 18`. The entries above took **27.6s**
and **15.7s** of real upstream generation, and are in `bridge.log`.

## Timeline — which contract produced these calls

The log timestamps are UTC (`Z`). Commits are local `+0700`.

| when | what |
| --- | --- |
| `2026-10-18T23:28:47Z` = **2026-10-19 06:28 +0700** | the two tool calls above |
| `2026-10-19 10:29 +0700` (`689100b`) | the conditional closer, `detail` fix, narration fix |
| `2026-10-19 10:33 +0700` (`8c421a2`) | protocol cut from 2044 to 1104 characters |

So these successes were produced under the **older, longer** contract — the
2044-character twelve-rule protocol with the unconditional closer.

That is reassuring about capability, and it is a caution about the current code:
**the present prompt has never been measured against the model.** The changes
since were made on reasoning, not on measurement, and one of them moved the
narration rule out of the protocol entirely in the belief that the closer
carries it better.

This is the honest shape of the remaining work: not "does it work", but "does
the version that exists now still work at the rate the old one did".

## What this proves

The whole chain works, on the real model, with the real free-tier deployment:

prompt assembly → the JSON envelope instruction → the model emitting
`{"tools":[{"name":"Read","input":{...}}]}` → bridge parsing → alias and schema
validation → conversion to an Anthropic `tool_use` block → `stop_reason:
"tool_use"` → HTTP 200.

`rejected` is empty in both. Nothing was dropped, aliased or repaired. The
`run` case needed no correction at all: **the first reply was usable.**

The specific claim this was mistaken for — *"tool call is implemented but the
model does not use it"* — is **false**. The model does use it.

## What this does not prove

- **The rate.** Two successes is not a rate. `probe-toolcall.mjs 5` exists to
  produce one, and it has not been run to completion.
- **That the current prompt still works.** See the timeline above.
- **The `write` case.** Unknown. It is the one case that needs two required
  arguments, so it is the one most likely to fail schema validation.
- **Anything through Claude Code.** The probe sends 3 tools and ~1 240 prompt
  tokens. Claude Code sends 23 tools and ~32 000. Compliance under a 20x larger
  prompt is a different and harder claim, and one round 9 of research suggests
  is where instruction stacking bites.

## Cost caveat

`tokens_spent` is an estimate. `/api/session/{id}/generate` does not return
usage, so the bridge derives it from prompt length. Treat 2695 and 1244 as
approximate. The relative comparison is still valid, because both come from the
same estimator: the `read` case cost about 2.2x the `run` case, which is exactly
what a second attempt looks like.

## The measurement that closes this

```sh
node probe-toolcall.mjs 5
```

Roughly 1 500 input tokens for four cases, against about 128 000 for the same
four through `claude -p`. It reports a pass rate per case; it does not assert.
The pass criterion is in `probe-toolcall.mjs` itself, stated before the run, so
the result cannot be reinterpreted afterwards.

Run it only when the quota allows. See `AGENTS.md` for why nothing else is
permitted.
