# Research: the `system` field, and a claim in the repo that does not reproduce

Round 9, read-only, zero token. Everything here was established without calling
a model.

## 1. `system` cannot be passed through the route the bridge uses

From `GET /openapi.json` on port 4599 (276 KB, static document, free to fetch):

| Endpoint | Body | `additionalProperties` |
| --- | --- | --- |
| `POST /api/session` | `id, parentID, title, agent, model, location, metadata, permissions` | **`false`** |
| `POST /api/session/{id}/generate` | **`prompt` only** | **`false`** |
| `POST /api/session/{id}/agent` | `{agent}` only | `false` |

`Agent.Info` does have a real top-level `system: string` — `Explore` carries 654
characters, `Title` 2119, `Summary` 647; `Build`, `General`, `Plan` have none.
But there is **no `system` on session create**, and `/generate` takes `prompt`
and nothing else.

**So the plan of sending a `system` field to replace OpenCode's compiled-in
system prompt does not exist on this API.** It cannot be tried and found to
fail; it is not addressable.

The one surviving lever is `POST /api/session/{id}/agent`, which switches the
agent and would pull that agent's `system` in. Whether OpenCode *replaces* its
own system prompt or *prepends* to it is unresolved. If it prepends, switching
agent adds ~7k tokens of conflict rather than removing any.

Corroboration that `system` is first-class: the binary contains the OpenCode
system prompt text and compiles the concept in.

## 2. The "deny rules disable the free tier" claim does not reproduce

`opencode-config/opencode.json:9-18`, `README.md:263-268` and `bridge.mjs`
around 1366-1381 all state that any `permissions: deny` rule makes the free tier
return 503, and the whole "deny rules are not load-bearing, safety is
structural" argument rests on it.

Six session-create calls were made against the live server:

| variant | result |
| --- | --- |
| title only | 200 |
| `agent: "build"` | 200 |
| `agent: "explore"` — carries a `system` **and** a `*/* deny` rule | 200 |
| inline `*/* deny` | 200 |
| inline `*/* allow` | 200 |
| a bogus agent id | 200 |

**All six returned 200.** The sessions were deleted afterwards and the count
returned to its original 50. Session create does not validate agent ids and does
not reject deny rules.

This is a statement about **this build, at session-create time**. It does *not*
establish that deny rules are fine at inference time — the check may simply have
moved downstream, or the original 503 may have been a rate limit misread as a
configuration failure, which is precisely the failure mode `start-bridge.ps1`
was rewritten to avoid.

The claim in the repo is currently **unreproduced**, not disproven. It is also
load-bearing, which makes it the most dangerous kind of unverified statement to
leave in place: it justifies a security posture.

### Where the check would have to live

The free-tier error string is **not in `opencode.exe`** (212 MB searched;
`FreeTierError`, `free tier`, `can only be used from within` all return zero
hits). So it comes from the hosted gateway, not from local validation. Nothing
local will tell us whether it fires at inference.

## 3. Authentication, for the record

The credentials are not the defaults in `bridge.mjs:43`. `OC_PASS` is read from
`.opencode-password` and injected by `start-bridge.ps1`. Requests to `:4599` need
`Authorization: Basic base64(opencode:<password>)`; without it, 401.

## 4. What this changes

- Drop the `agent` + `system` experiment. The API has no address for it.
- The deny-rule question is the one load-bearing claim left unreproduced, and
  it can only be settled by a token-bearing inference call. Until then the repo
  should say "unverified on this build" rather than asserting either way.
- Feasibility of tool calling is already answered — see
  `EVIDENCE-model-toolcall.md`. What remains is the *rate*, not the *whether*.

## 5. Not done

No web research was done. In particular there is **no** evidence gathered for
the claim that a positive formulation ("put the call in tools") outperforms the
current negation ("do not DESCRIBE what you are about to do"). That should be
treated as an open question, not as a finding.
