# RESEARCH - instruction phrasing, emission rate, and the decisive experiment

**Role:** Researcher (read-only). No repo file was modified. `bridge.mjs` was read via
`git show HEAD:bridge.mjs` into `%TEMP%\bridge-head.mjs` rather than from the working tree,
because a mutation-testing reviewer has it open and the working tree may be mid-mutation.

**Sources used:** primary papers and vendor docs fetched directly; local measurement of
`GET /openapi.json` (allowed, zero-token endpoint); `git show` for prompt archaeology.
Nothing was sent to the model.

**Confidence labels:** CAUGHT UP = read from the primary source today. MEASURED = measured on
this machine today. INFERRED = reasoned from a cited source. UNVERIFIED = stated but not
confirmed; flagged rather than dropped.

---

## 0. THE FINDING THAT CHANGES THE QUESTION

Before answering "negation vs positive", I measured what actually differs between the
prompt that produced the two successful tool calls and the prompt that ships now.
**MEASURED, today, from git objects:**

| | old (`689100b`) | now (`HEAD` = `187d436`) |
|---|---|---|
| `RESPONSE_PROTOCOL` length | **2015 chars / 37 lines** | **1087 chars / 18 lines** |
| "Never" in protocol | 5 | 3 |
| "Do not" in protocol | 2 | 0 |
| `FINAL:` tool-branch closer | **761 chars** | **761 chars** |
| closer byte-identical to old? | - | **YES** (string compare returned true) |
| forbidden example sentence in closer | yes | yes |
| "Never DESCRIBE an action..." in protocol body | **yes** | **no** |

**So the negation the question is about is not what changed.** The closer - the one containing
*"**Do not DESCRIBE** what you are about to do. A sentence like 'Continuing to read the file,
and kicking off research in parallel' performs nothing..."* - is **byte-identical** in the
measured prompt and the shipping prompt. It was not touched by the cut.

The entire delta is one rule **removed from the protocol body**, leaving it present only in
the closer: *"Never DESCRIBE an action instead of taking it."*

**Consequence:** reframing the closer from negative to positive is a **new change with no
rollback counterpart**. It is not what a rollback would undo. The actual old-vs-new question
is narrower and much more answerable: *does stating the narration rule twice (body + closer)
beat stating it once (closer only)?*

Corollary worth stating plainly: any experiment that A/Bs the two closers measures nothing,
because there is only one closer.

---

## KET QUA RESEARCH

**Van de:** Is the 1104-character prompt as reliable as the 2044-character one, and should the
negated narration rule in the closer be rewritten as a positive rule?

**Da kiem chung:**
- `git show` archaeology of `RESPONSE_PROTOCOL` and the `FINAL:` closer across every commit
  from `21f4783` to `HEAD` (table above; closer proven byte-identical).
- `GET http://127.0.0.1:4599/openapi.json` with Basic auth, today: `session.generate` body is
  `{prompt: string}`, `required:[prompt]`, `additionalProperties:false`. **MEASURED.**
- `https://opencode.ai/config.json` $defs, today: `Config.ProviderEncoded` has `body`;
  `Config.ModelEncoded` has `body`, `headers`, `variants`; `Config.AgentEncoded` has
  `system`. **MEASURED.**
- Read in full: arXiv 2209.12711v1, arXiv 2402.07896v2 (Table 1), arXiv 2512.14754v1
  (Table 1), arXiv 2512.14982v1. Read: platform.claude.com `increase-consistency`;
  platform.openai.com `structured-outputs`.

---

## RANKED FINDINGS

### 1. The current closer is the one prompt shape with published evidence of doing nothing or backfiring at 7B-13B. - HIGHEST IMPACT

**Claim.** A prohibition that *names the forbidden behaviour in the prompt* ("do not DESCRIBE
what you are about to do. A sentence like 'Continuing to read the file, and kicking off research
in parallel' performs nothing") is the "Pink Elephant" shape. Measured rate of producing the
forbidden behaviour (lower is better):

| Model | base rate (no instruction) | with "don't mention X" prompt | delta |
|---|---|---|---|
| OpenHermes-7B | 0.33 +/- 0.010 | **0.36 +/- 0.010** | **-0.03 - instruction made it worse** |
| OpenHermes-13B | 0.34 +/- 0.010 | **0.34 +/- 0.010** | **0.00 - no effect at all** |
| Llama-2-13B-Chat | 0.33 +/- 0.009 | 0.25 +/- 0.009 | +0.08 - weak |
| GPT-4 | 0.33 +/- 0.009 | 0.13 +/- 0.009 | +0.20 - real |

The paper's own words: *"baseline OpenHermes models exhibit an equivalent or increased tendency
to mention Pink Elephants following such directive prompts."*

**Source.** Castricato, Lile, Anand, Schoelkopf, Verma, Biderman - *Suppressing Pink Elephants
with Direct Principle Feedback*, arXiv:2402.07896v2, 13 Feb 2024, Table 1. **CAUGHT UP**
(full HTML read).

**Answering the explicit question - "is the evidence only about larger models?":**
Effectively yes for *this* construct. The gradient is monotone in capability: 7B negative,
13B zero, Llama-2-13B-chat small, GPT-4 large. `space-bunny-free` is a small free-tier model,
so it sits on the unfavourable end of exactly this gradient. That is the honest read and it is
not reassuring.

**Important caveat (do not skip).** The Pink Elephant task is *topical suppression* - "don't
mention rugby". The bridge's closer is *behavioural-shape suppression* - "don't narrate, call
the tool instead". Different construct. The paper's Limitations section lists more complex
constraints and generalisation as untested. Treat the transfer as **INFERRED, medium
confidence** - strong prior, not a measurement of this case.

**Action it implies:** do not rewrite the closer on this evidence alone. Run the
"forbidden sentence" probe (Task 3) first - ~8 000 tokens, and it tests *this exact mechanism*
rather than a paper's topic-suppression analogue.

---

### 2. Prompt repetition: 47 wins, 0 losses - directly relevant to the rule that WAS deleted.

**Claim.** Duplicating the input prompt improves accuracy for non-reasoning models.

> "Prompt repetition wins **47 out of 70** tests, with **0 losses**." ... "improves the accuracy
> of **all tested models**." Strongest example: Gemini 2.0 Flash-Lite on NameIndex
> **21.33% -> 97.33%**. Control: padding the input to the same length with periods "does not
> improve performance" - the gain is from *meaningful* repetition, not length. With reasoning
> enabled it is neutral-to-slightly-positive (5 wins, 1 loss, 22 ties). No latency or
> output-length penalty; the cost falls in prefill, i.e. **input tokens**.

Models: Gemini 2.0 Flash / Flash-Lite, GPT-4o / GPT-4o-mini, Claude 3 Haiku / 3.7 Sonnet,
DeepSeek V3. Benchmarks: ARC-C, OpenBookQA, GSM8K, MMLU-Pro, MATH + 2 custom.

**Source.** Leviathan, Kalman, Matias (Google Research) - *Prompt Repetition Improves
Non-Reasoning LLMs*, arXiv:2512.14982v1, 17 Dec 2025. **CAUGHT UP** (full text).

**Why it matters here and why it is not free.** The cut removed one restatement of the
narration rule from the protocol body on the theory that repetition wastes tokens. This paper
says verbatim repetition is a win with no losses, and the padding control proves it is not a
length artefact. **But:** it was run on benchmarks, not on a system prompt, and the gain was
largest when the task required holding a long list in mind (NameIndex / MiddleMatch). The
envelope contract is short and local. **INFERRED, medium confidence.**

**Counter-consideration.** The opposite direction has support too: *distractor* constraints are
what hurts. IFEval++ (finding 3) shows rephrasing is the mildest subset and distractors are
worse. The old protocol's removed lines were a restatement plus a paraphrase ("Now I will read
the file" or "Continuing to check the rest") - arguably a distractor, not a repetition. **The
2015->1087 cut removed a repetition and a distractor simultaneously, and the evidence is split
on which mattered.**

**Action it implies:** the cheapest hypothesis worth testing is not "old vs new" but
**"new protocol body + one line of narration rule restored"** - ~110 chars, not 1000.

---

### 3. Semantic-preserving rewording of an instruction is routinely worth double-digit accuracy on small models.

**Claim.** Across 46 models on IFEval++ (each IFEval prompt rewritten 10 ways: rephrasing,
distractor addition, constraint reconfiguration):

| model | IFEval acc | reliable@10 (all 10 cousins) | delta |
|---|---|---|---|
| GPT-5 | 95.9 | 78.4 | -18.3% |
| LLaMA-3.3-70B-Instruct | 92.1 | 71.0 | -22.9% |
| Qwen3-8B | 87.6 | 58.8 | -32.9% |
| LLaMA-3.1-8B-Instruct | 75.8 | 41.4 | **-45.4%** |
| Qwen2.5-7B-Instruct | 73.0 | 34.8 | **-52.3%** |
| GPT-3.5-turbo-1106 | 61.6 | 27.9 | **-54.7%** |
| Qwen3-0.6B | 58.0 | 22.2 | **-61.8%** |

Degradation is **monotone in inverse capability** - the smaller the model, the more a
meaning-preserving rewording costs. **Rephrasing is the mildest** of the three (Qwen3-8B:
rel@2 83.4, rel@4 79.5, vs acc 87.6); distractor and reconfiguration are worse.

**Source.** Dong et al. - *Revisiting the Reliability of Language Models in
Instruction-Following*, arXiv:2512.14754v1, 15 Dec 2025, Table 1. **CAUGHT UP** (full text).

**Confidence:** CAUGHT UP for the table. INFERRED for "a 1104-vs-2015 char prompt rewrite is
the same kind of event" - it is a rephrasing plus deletions, so milder than a full rephrase, but
not nothing.

**Action it implies:** this is the strongest *prior* that the cut was a regression. It also sets
the honest expected effect size at **tens of points, not a few** - which makes the experiment in
Task 3 *harder*, not easier.

---

### 4. Negative vs positive phrasing: real evidence, but about a different construct than "put it in tools".

**Claim A (task-level negation).** Negating the instruction flips performance to chance and gets
**worse with scale**:

> "for all tasks ... an inverse scaling law is shown: larger LMs tend to perform worse on negated
> prompts." ... "this leads to a flat line performance for the average of negative and positive
> prompts that is ~50% for all of the tasks. In other words, this means that the LMs could not
> find any distinction between the original and the negated prompts." 13-year-old humans close
> only a **31.3%** gap that the best method leaves.

Scope: OPT 125M-175B, GPT-3 (Ada to 175B), T0 3B/11B, InstructGPT, ICL k=2/4/8, fine-tuning,
9 datasets x 300 instances. Fine-tuning "helps" but is zero-sum (original-task performance
degrades by the same amount). Also holds for instruction-tuned LMs.

**Source.** Jang, Ye, Seo - *Can LLMs Truly Understand Prompts? A Case Study with Negated
Prompts*, arXiv:2209.12711v1, 26 Sep 2022. **CAUGHT UP** (full text). Follow-on: Zhang et al.,
*Beyond Positive Scaling*, arXiv:2305.17311 (ACL 2023 Findings) - NeQA, 1718 items; scaling
trend shifts inverse -> U-shaped -> positive as the prompting method improves; negation
understanding is sigmoid-shaped with an emergent transition point. **CAUGHT UP** (abstract).

**Claim B (the gap to be honest about).** None of that measures *"comply with a negated format
rule"*. The task is always *"produce a negated output"* ("generate the **incorrect** answer").
The closer says *"don't put the call in text"* - the model is not asked to negate anything, only
to avoid one field. **Treat A as a weak-to-moderate prior for this prompt. INFERRED.**

**Claim C (the one directly on point).** Anthropic's own guidance:
- "Constrain with examples - **Provide examples of your desired output. This is more effective
  than abstract instructions.**" No number attached. **CAUGHT UP.**
- Same page: *"Prefilling is **not supported on Claude 4.6 and later models**. Use structured
  outputs ... or system prompt instructions, instead."* **CAUGHT UP** - new, and it matters for
  Task 2.

**No peer-reviewed controlled study holding an instruction's meaning fixed while varying only
negative-vs-positive phrasing, with an effect size, was found.** Labelled **UNVERIFIED (not
found)** rather than dropped. Searches run: three phrasings of "negative vs positive instruction
LLM"; a targeted search on DIM-Bench negative requirements; a targeted search on controlled
rephrasing studies. Nearest is **DIM-Bench** (Hwang et al., *LLMs can be easily Confused by
Instructional Distractions*, ACL 2025, arXiv:2502.04362), which IFScale cites for vulnerability
to "negative or distractor requirements" - I confirmed the paper exists and its title, but **did
not read it and have no numbers**. INFERRED / partially unverified.

**Action it implies:** the positive reframe of the closer is a reasonable, cheap change with
moderate evidence - not a proven fix. Ship it only behind a measurement.
---

### 5. Position: the end of the prompt is a reasonable place, but not for the reason the code comment claims.

**What the code comment says** (`bridge.mjs`, `RESPONSE_PROTOCOL` docblock):
*"The closer says it again at the end of the prompt, where it is far more likely to land."*

Evidence:
- **Serial position effects are real and widespread** across decoder and encoder-decoder models
  and task types, and "while carefully designed prompts can somewhat mitigate these biases,
  their effectiveness is **inconsistent**" - Guo & Vosoughi, arXiv:2406.15981. **CAUGHT UP.**
- **But "recency wins" is not a general rule for instruction compliance.** *Order Matters*
  (Zeng et al., ACL Findings 2025, arXiv:2502.17204) measures position bias directly: LLMs
  prefer **hard-to-easy** constraint order; LLaMA3-8B shows ~7% spread between extreme orders
  (Qwen2.5-7B ~5%); in multi-round settings the spread reaches ~25%. Order, not position, is the
  operative variable.
- **And at low constraint counts, primacy can dominate.** IFScale (arXiv:2507.11538) reports a
  primacy-effect ratio (errors in last third / errors in first third) of **1.80** for gpt-4o at
  10 instructions and 1.31-1.42 at 50 - i.e. *earlier* items are followed more. The ratio peaks
  only around 150-200 instructions, far above the bridge's ~8.

**Read together:** with ~8 constraints the primacy and recency effects are small and of
uncertain sign. Keeping the closer at the end is defensible; the comment's confidence ("far
more likely to land") is not supported. **CAUGHT UP** for each citation. **INFERRED** for the
combination.

**Action it implies:** do not restructure the prompt on position grounds. There is no evidence
here big enough to pay 1000 input tokens for.

---

### 6. What is and is not available through `POST /api/session/{id}/generate` - measured today.

| technique | evidence | usable here? |
|---|---|---|
| **structured output / JSON mode / `response_format`** | OpenAI: Structured Outputs "ensures the model will always generate responses that adhere to your supplied JSON Schema"; on `gpt-4o-2024-08-06`+ **100% schema adherence**. Anthropic: `output_config.format:{type:"json_schema"}` + `strict:true`. **CAUGHT UP.** | **NO, not directly.** `/generate` body is `{prompt: string}`, `additionalProperties:false` - **MEASURED today**. **Possibly via config:** `Config.ProviderEncoded.body` exists - **MEASURED today** from `opencode.ai/config.json`. UNVERIFIED whether the gateway honours it. Prior repo research flags the failure mode as *silent*: a payload it ignores means you think you enabled it. |
| **prefill / assistant-prefix forcing** | Was the standard trick; **Anthropic removed it on Claude 4.6+ - requests with prefilled assistant messages return 400.** **CAUGHT UP** (platform.claude.com note, corroborated by Vertex/HN reports). | **NO.** No assistant-turn field in `/generate`. A *text-level imitation* is possible (end the prompt string with `{"text":"` and have the bridge re-prepend it) but **UNVERIFIED**, and it changes the parse contract. |
| **temperature / top_p** | Universal guidance: 0.0-0.2 for structured output; one practitioner report of ~15% format error rate at T=0.7 vs ~0 at T=0.1 - **blog-grade, INFERRED.** IFEval++ used **greedy decoding** "because it is suitable for reliability evaluation and provides a reproducibility guarantee". | **NO direct control.** Only via `providers.*.models[*].body`. **Highest-leverage UNVERIFIED knob**, because greedy decoding would make repeats near-deterministic and collapse the noise floor. |
| **few-shot** | No credible quantitative study for text-envelope tool emulation found, in this pass or in the repo's prior passes. **UNVERIFIED.** | Possible, but token-costly against a hard rate limit. |
| **repeating the instruction at start and end** | Strong positive evidence - finding 2. **CAUGHT UP.** | **YES, free to try.** This is exactly what the old prompt did and what the cut removed. |
| **constraining the schema** (fewer tools, simpler `input_schema`) | Repo already has the context-rot ablation: -2.3 points average, -32.0 worst case from adding irrelevant schemas. **CAUGHT UP** (via RESEARCH-tool-call-reliability.md 2.3). | **YES** - bridge-side, no upstream cost. Already partly done in the probe (3 tools). |
| **prompt caching** | Anthropic requires explicit `cache_control`; free tier sits behind `opencode.ai/inference`. Prior repo note: "no prompt caching on this deployment". **UNVERIFIED** - no endpoint exposes it. | **NO.** Even if it existed, a cache *write* is priced at 1.25x on Anthropic, so on a budget-constrained tier it can be worse than no cache. |

**The measurement that changes the plan:** `Config.ProviderEncoded.body` and
`Config.ModelEncoded.body` exist in the live schema. If either is honoured, you can set
`temperature: 0` **without touching `bridge.mjs`**, from config, and every experiment in Task 3
becomes dramatically cheaper. That deserves its own one-token-cost probe.

---

## HUONG GIAI QUYET

### Huong 1 (KHUYEN NGHI): two small pre-registered probes before any A/B

**Files touched:** `probe-toolcall.mjs` only. **No change to `bridge.mjs`.**

#### Probe A - "is `/generate` deterministic?" (~2 000 tokens)

Same request twice, 5 s apart. Compare `data.text` byte-for-byte.

    // probe-toolcall-det.mjs - keep in %TEMP% first, promote only if it earns its place
    async function one() {
      const r = await fetch(BRIDGE + "/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "space-bunny-free", max_tokens: 2048, tools: TOOLS,
          messages: [{ role: "user", content: "Read notes.txt and tell me what it says." }] }),
      });
      return JSON.stringify(await r.json());
    }
    const a = await one(); await new Promise(x => setTimeout(x, 5000)); const b = await one();
    console.log("deterministic:", a === b);

- **If true:** sampling noise is ~0. Variance must come from a *paraphrase panel*, so build a
  12-item paraphrase panel of the same task instead of repeating one prompt.
- **If false:** you have the repeat-variance for free. Record the prefix distance between the
  two replies - that is the noise floor.

**Risk:** none. **Confidence:** high. **Cost:** ~2 000 input tokens.

#### Probe B - "does the closer plant the sentence it forbids?" (~8 000 tokens)

Two arms, identical except one clause in the `FINAL:` closer:

- **Arm A (as shipped):** contains `A sentence like` + `"Continuing to read the file, and kicking off research in parallel" performs nothing,`
- **Arm B:** same sentence with that clause replaced by `so the turn ends having done no work.`

How to run without editing the repo: set an env var the closer reads, e.g. `CLOSER=stripped`.
If you do not want to touch the source at all, run two bridge processes on two ports from two
**copies** of `bridge.mjs` in `%TEMP%` - a copy is not the repo file, so the reviewer is
unaffected.

**Case:** one per arm, mid-loop so the bridge's own narration detector is live - a user turn
followed by a `tool_result`, phrased to invite exactly that sentence.

**Endpoint (declared before running):** fraction of replies containing the substring
`"Continuing to read"` or any of `"kicking off"` / `"in parallel"`.

**Pre-registered criterion:** McNemar exact, two-sided. 4 discordant pairs all one way is only
*suggestive*; you need **6 discordant pairs in one direction for p < 0.05** (2 * 0.5^6 = 0.031),
5 for p < 0.10. With 4 pairs per arm you can detect only an extreme effect. Write the threshold
down before sending anything.

**Why this is the right first experiment.** It does not require reconstructing the old prompt,
does not touch `RESPONSE_PROTOCOL`, and it targets the one mechanism with a published 7B/13B
effect of **-0.03 to 0.00**. If the forbidden sentence appears at the same rate with and without
being named, the Pink Elephant concern is dead for this model and you should stop worrying about
phrasing and go measure the rate instead.

**Risk:** using `looksLikeNarration` as the endpoint means testing the prompt with the detector
that was tuned on 8 replies. Use the **raw response text** as the primary endpoint and log the
detector's verdict as secondary. **Confidence:** high that the measurement is cheap and clean;
medium that it generalises.

---

### Huong 2: the actual OLD-vs-NEW A/B, honestly costed

**Why this is not first.** Per-case cost today: the repo measured **1 222 input tokens** for a
3-tool single-message probe with the *old* protocol (`RESEARCH-tool-call-reliability.md` 5.2,
E3). The cut removed 928 chars ~= 331 tokens at the bridge's own 2.8 char/token estimator, so
**~890 tokens per probe case now**. Call it 900-1 250.

Sample size, two proportions, alpha = 0.05 two-sided, 80% power:

| effect to detect | n per arm | tokens per arm (4 cases/round) | total |
|---|---|---|---|
| 50% -> 90% | ~20 | ~80 000 | **~160 000** |
| 50% -> 75% | ~58 | ~230 000 | **~460 000** |
| 60% -> 85% | ~49 | ~200 000 | **~400 000** |
| 70% -> 80% | ~293 | ~1 200 000 | **~2 400 000** |

**At a 2 000-token-per-arm budget you get about 1.5 samples per arm. You cannot distinguish
anything.** That is the honest finding and it should be reported as a finding, not hidden.

Paired design helps power but not n: McNemar still needs **6-8 pairs all discordant** to reach
p < 0.05, i.e. ~8 rounds x 4 cases x 2 arms x ~1 000 tokens ~= **64 000 tokens total** - and
that is the floor for detecting a *large* effect.

**The cheapest version still worth running (~48 000 tokens):**

1. **Fixed in advance, per arm:** pass if narration rate <= 1/12 **and** tool-case pass rate
   >= 11/12. Anything less and both prompts are equally good enough - stop.
2. **Blocked and interleaved:** A,B,A,B,... within each round. Never 12 of one arm then 12 of
   the other. The model is throttled and behaves differently by day; unblocked ordering
   confounds arm with time-of-day completely.
3. **Report `attempts`, not just pass/fail.** The old prompt's two successes had `attempts: 2`
   and `attempts: 1`; mean attempts is far lower-variance than a binary outcome and costs
   nothing extra.
4. **Randomise case order inside each arm**, so "case 3 always runs at 14:05" cannot masquerade
   as an arm effect.

**Changes to `probe-toolcall.mjs`:** add `--protocol=old` selection (env var driving a
`RESPONSE_PROTOCOL` override), interleaved scheduling, per-case `attempts` capture, and the arm
label in every output line.

**Risk:** 48-64 k tokens on a continuously throttled free tier is a real fraction of the quota.
If `GET /effort` shows the tier already saturated, the correct action is to **wait**, not to
shrink n - a 4-round run that cannot reach significance costs 25% of the budget to say so.

**Confidence:** high that this is the minimum viable design; high that 2 000 tokens/arm is
insufficient.

---

### Huong 3: the cheapest candidate fix, if the rate turns out to be bad

Not "restore 2051 chars". Restore **one line** into the protocol body, keeping the closer:
`Never DESCRIBE an action instead of taking it. Any intent to act belongs in "tools".`
(~110 chars, ~40 tokens). This isolates finding 2 (repetition) from finding 1 (phrasing), which
the 2015->1087 cut confounded - it removed a repetition *and* a distractor *and* three
restatements of "one JSON object" simultaneously. **One variable at a time.**

Then, separately, rewrite the closer's forbidden-sentence clause to positive form:
`"text" is for the finished answer only. An unfinished task goes in "tools".` - keeps the
consequence sentence, drops the quoted anti-example.

Both are 0-110 tokens against a ~900-token floor. **INFERRED, medium confidence, cheap to test
with Huong 1 Probe B.**

---

## Task 4 - WHAT A NEGATIVE RESULT MEANS, AND THE ROLLBACK PATH

**The old prompt is fully recoverable. Verified today.**

| commit | `RESPONSE_PROTOCOL` | closer | note |
|---|---|---|---|
| `21f4783` | 1826 chars | yes | original, shorter than the measured one |
| `31bc342` ... `689100b` | **2015 chars** | yes | the measured, 2-success version |
| `8c421a2` | 1087 chars | yes | **the cut** |
| `HEAD` (`187d436`) | 1087 chars | yes | shipping |

- **`689100b` is the last commit carrying the prompt that produced the two real tool calls.**
  `git show 689100b:bridge.mjs` gives the file verbatim: the 2015-char twelve-rule protocol
  **and** the narration rule.
- **`8c421a2` changed exactly one hunk in `bridge.mjs`** (`@@ -1099,42 +1099,49 @@ function
  buildTranscript(body)`), plus `run-tests.ps1` and `test-mock.mjs` (+48 lines).
- **Small discrepancy worth recording:** `EVIDENCE-model-toolcall.md` and the code comment say
  "2044 characters". The literal in git measures **2015** by the method above (2051 by another).
  The figures differ by <= 36 characters, presumably by what is counted. **Do not go hunting
  for a 7-character discrepancy**; record it and move on.

**Rollback options, best first:**

1. **`git revert --no-commit 8c421a2`, then re-apply only the non-protocol parts.** Reverses the
   cut while keeping everything from `b7626aa` ... `187d436`.
   **Caveat:** 8c421a2 also added 48 lines to `test-mock.mjs` that almost certainly assert on the
   *new* prompt text. Reverting wholesale will fail those. Expect to fix that file by hand.
2. **Do NOT `git checkout 689100b -- bridge.mjs`.** That loses 8c421a2's later fixes *and*
   everything in `b7626aa`, `a0caace` (the restored injection fix), `187d436` - including the very
   fix `a0caace` exists to undo a `git add -A` accident. Use option 1 or 3.
3. **Copy the 37-line `RESPONSE_PROTOCOL` literal out of `git show 689100b:bridge.mjs`** and paste
   it into the current constant. One constant, one hunk, no test churn. **Recommended.**

**What a negative result means, concretely.** If the old prompt measures no better:

- Feasibility is unaffected - two real tool calls already exist (`EVIDENCE-model-toolcall.md`).
- Finding 3 (IFEval++ rephrasing costs small models tens of points) is wrong for *this* prompt
  shape. Record it as a bounded negative, not a general one.
- The remaining failure modes are then almost certainly **not** phrasing. The live
  `looksLikeNarration` backstop plus the `[CORRECTION]` retry already cover narration, so the next
  thing to measure is `attempts` per case - if the model emits a usable call on attempt 2, the
  problem is convergence, not instruction following, and rejection sampling is the lever, not the
  prompt (IFEval++: reliable@10 plateaus around n = 12; Qwen3-4B/8B beat LLaMA-3.3-70B at n = 3).
- **Do not** conclude "prompt engineering is exhausted" from one A/B. Conclude it from two.

---

## NGUON THAM KHAO

| source | what it gave |
|---|---|
| `https://arxiv.org/html/2402.07896v2` (full text + Table 1) | Pink Elephant numbers: OpenHermes-7B delta -0.03, 13B 0.00, Llama-2-13B-chat +0.08, GPT-4 +0.20 |
| `https://arxiv.org/html/2512.14982v1` (full text) | prompt repetition 47/70 wins, 0 losses; padding control; Gemini Flash-Lite 21.33 -> 97.33 |
| `https://arxiv.org/html/2512.14754v1` (full text + Table 1) | reliable@k table; small models lose 45-62% to cousin prompts; greedy decoding for reproducibility |
| `https://arxiv.org/html/2209.12711v1` (full text) | inverse scaling on negated prompts; ~50% average; 31.3% human gap |
| `https://arxiv.org/abs/2305.17311` (abstract) | NeQA; inverse -> U-shaped -> positive as prompting improves |
| `https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/increase-consistency` | "examples more effective than abstract instructions"; **prefill removed on Claude 4.6+** |
| `https://platform.openai.com/docs/guides/structured-outputs` | structured outputs 100% schema adherence on gpt-4o-2024-08-06+ |
| `https://arxiv.org/abs/2406.15981` | serial position effects; prompt mitigation "inconsistent" |
| `https://aclanthology.org/2025.findings-acl.646` / arXiv:2502.17204 | order matters: hard-to-easy; ~7% LLaMA3-8B spread |
| `https://arxiv.org/abs/2507.11538` | primacy ratio 1.80 at 10 instructions (gpt-4o); peaks at 150-200 |
| `https://arxiv.org/abs/2502.04362` (Hwang et al., ACL 2025) | DIM-Bench - title/venue confirmed, **numbers not read, INFERRED** |
| `GET http://127.0.0.1:4599/openapi.json` (Basic auth, today) | `/generate` = `{prompt}`, `additionalProperties:false` |
| `https://opencode.ai/config.json` $defs (today) | `ProviderEncoded.body`, `ModelEncoded.body`, `AgentEncoded.system` exist |
| `git show` across 11 commits | protocol sizes 1826 -> 2015 -> 1087; closer byte-identical old vs HEAD |

**Explicitly UNVERIFIED - do not treat as established:**

1. Whether `providers.*.models[*].body` actually reaches the upstream gateway. This is the
   highest-value unmeasured fact in this report.
2. Whether `space-bunny-free` is a reasoning or non-reasoning model - decides whether finding 2
   applies at all (the paper's gain is non-reasoning-only).
3. Whether the deployment is greedy-decoded. Decides the shape of every experiment.
4. DIM-Bench's actual numbers.
5. Whether "positive framing beats negative for *format compliance*" has ever been measured in a
   controlled study. I looked and did not find one. Finding 4 Claim A is about task-level negation
   and is only a weak prior for this case.
6. Whether the Pink Elephant topical-suppression result transfers to behavioural-shape
   suppression. Different construct; the paper's Limitations section does not cover it.
7. The current effective token cost per probe case (~890) is derived by subtraction from an E3
   measurement taken under a possibly different prompt. Treat as +/-30%.

---

## THU NGHIEM NHANH

Run in this order. Nothing above line 3 costs more than ~10 000 tokens total.

1. **`GET /effort`** on the bridge, and `GET /health`. Free. If the tier is saturated, stop -
   every number below becomes noise.
2. **Probe A (determinism), ~2 000 tokens.** Same request twice. Decides the shape of everything
   else. Run this before designing anything.
3. **Probe B (forbidden-sentence), ~8 000 tokens.** 2 arms x 4 cases. Primary endpoint is a raw
   substring count, not `looksLikeNarration`. Pre-register the McNemar threshold (6/6 for
   p < 0.05) **before** sending anything.
4. Only then choose between Huong 2 (48-64 k tokens) and Huong 3 (~110 tokens, one variable).

**One thing to do regardless, at zero token cost:** add the table from section 0 to
`EVIDENCE-model-toolcall.md`. The current text correctly says the cut "moved the narration rule
out of the protocol entirely in the belief that the closer carries it better", but does not say
that **the closer itself is byte-identical between the two prompts**. That fact changes what a
rollback even means, and it is the first thing anyone should know before spending quota.
