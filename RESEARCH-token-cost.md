# Nghiên cứu — giảm chi phí token cho một vòng lặp agent LLM

Ngày: 2026-10-18 · Phạm vi: `claude-code-bridge/bridge.mjs` · Người viết: subagent nghiên cứu, không sửa file nào ngoài file này.

---

## 0. Cách đọc file này

**Mức chắc chắn**

| Nhãn | Nghĩa |
| --- | --- |
| `CAUGHT UP` | Đọc trực tiếp từ tài liệu chính thức / spec, hoặc tự đo trên máy này bằng phép đo **không gọi model**. |
| `INFERRED` | Suy luận từ bằng chứng đã xác nhận. Chưa có nguồn trực tiếp hoặc chưa chạy end-to-end. |
| `UNVERIFIED` | Chưa biết. Ghi rõ là không biết. |

**Loại nguồn** ghi kèm mỗi trích dẫn:
`[DOC]` tài liệu chính thức của nhà cung cấp · `[BLOG1]` blog Engineering **của chính Anthropic** (vẫn là first-party, khác hẳn blog bên thứ ba) · `[BENCH]` báo cáo kỹ thuật có phương pháp và mã nguồn · `[SPEC]` OpenAPI/schema đọc từ `opencode serve` đang chạy · `[MEAS]` tự đo trong file này, **không gọi model** · `[SPEC-EXT]` tài liệu OpenAI (đường OpenAI-compatible mà `space-bunny-free` đi qua).

> **Không có phép đo nào trong file này tốn token.** Không `claude -p`, không `probe-behaviour.mjs`,
> không suite live. Chỉ dùng: đọc file local, `GET /openapi.json`, `GET /api/model`, `GET /health`,
> và phân tích `bridge.log` đã có sẵn.
> Riêng §6 (giảm chi phí retry) là nơi có **phép đo lịch sử thật** từ 62 turn đã chạy — đó là dữ liệu,
> không phải suy đoán.

---

## 1. TL;DR

| # | Đề xuất | Tiết kiệm /lượt | Rủi ro | Mức |
| --- | --- | --- | --- | --- |
| **P1** | **Xoá tool result cũ, thay bằng stub** (giữ 3 result gần nhất ở dạng đầy đủ) | **~20–29k** trên turn sâu | Trung bình | CAUGHT UP (khuyến nghị) + INFERRED (con số) |
| **P2** | **Rút gọn prompt ở lượt retry** (bỏ `description` khỏi schema, bỏ phần hội thoại đã xử lý xong) | **~15–25k × 27% lượt** | Trung bình-thấp | MEAS (tỉ lệ retry) + INFERRED (mức tiết kiệm) |
| **P3** | **Đo lại khối tool schema trước khi động vào nó** | 0 (chỉ đo) | Rất thấp | MEAS |
| **P4** | Ước lượng token **tách theo loại văn bản** (prose vs JSON) | 0 token, đúng hơn | Thấp | CAUGHT UP + MEAS |
| **P5** | Bỏ `tool_choice` khỏi danh sách tool khi dựng lại | 0–500 | **Cao** | CAUGHT UP (không khuyến nghị) |
| **P6** | Just-in-time tool loading (tool search emulation) | ~10–20k | **Rất cao** | CAUGHT UP (bằng chứng) + CAUGHT UP (không nên ở 23 tool) |
| **—** | **Prompt caching (42k → ~1k)** | — | — | **KHÔNG KHẢ DỤNG. Xem §3.** |

**Câu trả lời ngắn cho câu hỏi quan trọng nhất:** *không*, phần lớn chi phí token **không** phải vì
OpenCode không cache. Nó là **ba lớp rào độc lập**, và cả ba đều đóng. Chi tiết ở §3.5.

---

## 2. Số đo baseline — không tốn token

`CAUGHT UP` `[MEAS]`. Nguồn: `bridge.log`, các dòng `kind:"start"` và `kind:"done"` đã có sẵn trên đĩa.

### 2.1 Sàn cố định của prompt (đo được, tuyệt đối)

Một request **không tool, không system prompt, một tin nhắn user 1 dòng** vẫn tốn:

```
{"tools":0,"messages":1,"prompt_tokens":1009}
```

Phân rã 1009 token đó bằng cách đếm ký tự trong chính source (`CAUGHT UP` `[MEAS]`):

| Thành phần | Ký tự | Token @2.8 |
| --- | ---: | ---: |
| `RESPONSE_PROTOCOL` | 2 015 | 720 |
| Closer `FINAL: reply with ONE JSON object…` | 709 | 253 |
| Nhãn/markdown (`# SYSTEM PROMPT`, `[user] `, ngắt dòng) | ~100 | 36 |
| **Tổng** | **2 824** | **1 009** |

→ Khớp **chính xác** với log. Không có thành phần nào ẩn. `CHARS_PER_TOKEN = 2.8` hiệu chỉnh
rất tốt cho văn xuôi tiếng Anh: 2 824 ký tự / 1 009 token = **2.80**. Sàn này là **chi phí cố định
2.3%** của một turn 43k, nhưng là **96%** của một turn probe.

### 2.2 Giá của một tool

```
tools:0 → 1 009 token      tools:3 (schema tối giảu) → 1 240 token
→ 3 tool tối giảu = 231 token  ⇒  ~77 token / tool
```

Con số này **không** áp dụng cho Claude Code: schema của Claude Code sinh từ Zod và có mô tả dài
(xem §4.1 — Anthropic khuyến nghị **3–4 câu** mỗi tool).

### 2.3 Turn sâu, và giá của việc retry

`CAUGHT UP` `[MEAS]` — 62 turn thật đã hoàn tất:

```
sum prompt_tokens (chỉ attempt 0) :   910 825
sum tokens_spent (mọi attempt)    : 1 382 165
retry tax                          :   471 340   =  34.1% tổng input token
turn cần >1 attempt                :   17 / 62   =  27.4%
prompt trung bình / turn           :   14 691
prompt lớn nhất                    :   75 517
```

Đây là con số quan trọng nhất của toàn bộ file: **một phần ba token đã chi là do retry.**
Và nó tập trung đúng vào lúc prompt đã lớn nhất — vì `handleMessages` gửi lại **toàn bộ** transcript
mỗi lượt, nên giá của một lượt retry luôn bằng giá của cả turn.

---

## 3. Prompt caching — câu hỏi quan trọng nhất

### 3.1 Semantics của Anthropic `cache_control`

`CAUGHT UP` `[DOC]` <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>

**Cấu trúc & thứ tự.** Prefix được cache theo thứ tự cố định: **`tools` → `system` → `messages`**.
Đây là một *thứ bậc*, không phải ba khối độc lập.

**Hai chế độ.**

| Chế độ | Cách bật | Hành vi |
| --- | --- | --- |
| Tự động | `cache_control: {type:"ephemeral"}` ở top-level request | Hệ thống đặt breakpoint ở block cacheable cuối cùng và **tự dịch tiến** khi hội thoại dài ra |
| Tường minh | `cache_control` trên từng content block | Kiểm soát chính xác; tối đa **4 breakpoint** |

**TTL.** Mặc định **5 phút**; `ttl: "1h"` có giá **2×** input. Vòng đời đo từ **đầu** request ghi/đọc
cache, không phải từ cuối response — một response stream 4 phút sẽ chỉ còn ~1 phút cho request kế.

**Ngưỡng cacheable tối thiểu** (Claude API): 512 token (Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Fable 5.1),
1 024 (Sonnet 5 / 4.6 / 4.5), 2 048 (Opus 4.7), 4 096 (Opus 4.6 / 4.5). Dưới ngưỡng → **không cache,
không báo lỗi**.

**Lookback = 20 block.** Khi không khớp ở breakpoint, hệ thống lùi từng block tối đa 20 vị trí,
tìm entry mà **request trước đã ghi**. Nó không "phát hiện nội dung ổn định" — chỉ tìm cái đã ghi.
Một chuỗi `tool_use` liên tiếp tính là **một** vị trí (tương tự `tool_result`), nên turn gọi nhiều
tool song song không tự đẩy entry của turn trước ra khỏi cửa sổ.

**Cái làm hỏng cache.** `CAUGHT UP` `[DOC]`:

| Thay đổi | Mất cache |
| --- | --- |
| **Sửa định nghĩa tool** (tên, mô tả, tham số) | **toàn bộ** — tools, system, messages |
| Bật/tắt web search hoặc citations | system + messages |
| Đổi `tool_choice`, `disable_parallel_tool_use` | messages |
| Đổi `output_config.effort` | messages (luôn luôn) |
| Đổi tham số thinking | messages (luôn luôn) |

**Giá.** Cache write 5m = 1.25× input; 1h = 2×; **cache read = 0.1×** input (0.025× trên
Fable 5.1 / Mythos 5.1; 0.05× trên Opus 5.5 / Sonnet 5.5). Breakpoint bản thân **không tốn phí**.

### 3.2 Vì sao con số giá này vô dụng ở đây

Model của bridge là **free tier**: `cost = {input: 0, output: 0, cache: {read: 0, write: 0}}`
(`CAUGHT UP` `[MEAS]`, `GET /api/model`). Ngay cả khi cache được thì **0.1×0 = 0**. Cache không
tiết kiệm tiền — nó chỉ tiết kiệm **latency** và, quan trọng hơn với bridge, có thể **giảm
quota rate-limit**. Mà cái cuối thì lại là thứ **không đo được** ở đây (xem §3.4).

### 3.3 OpenAI-compatible: cổng của `space-bunny-free` có cache không

Route của model này là `@opencode/ai/providers/openai-compatible` tới
`https://opencode.ai/inference/openai/v1` (`CAUGHT UP` `[MEAS]`).

**Semantics OpenAI** `CAUGHT UP` `[SPEC-EXT]` <https://platform.openai.com/docs/guides/prompt-caching>

- Bật **mặc định**, không cần gì từ client. Ngưỡng tối thiểu **1 024 token** (GPT-5.6+), model cũ
  biến thiên theo cấu hình request.
- Implicit breakpoint ở **cuối message eligible gần nhất**; lookup boundaries gồm
  "**up to 20 earlier eligible message endings**".
- TTL: `in_memory` ~5–10 phút; `24h`; GPT-5.6+ dùng `prompt_cache_options.ttl = "30m"`.
- **Quan trọng — rate limit:** *"Do cached prompts count toward rate limits? **Yes.** Cached
  input tokens still count toward tokens-per-minute limits. Prompt caching does not change how
  rate limits are calculated."*

→ Ngay cả khi cổng có cache, **giới hạn tốc độ của OpenCode có tính token cache hay không thì không
biết** (`UNVERIFIED`), và `GET /api/model` không nói. Đây là lý do lớn nhất để không đầu tư vào đây.

**Metadata của model** `CAUGHT UP` `[MEAS]` — đọc trực tiếp `GET /api/model`:

```
space-bunny-free
  package     : @opencode/ai/providers/openai-compatible
  compatibility: { "reasoningField": "reasoning_content" }      ← không có gì khác
  cost        : {"input":0,"output":0,"cache":{"read":0,"write":0}}
  limit       : { "context":1048576, "input":524288, "output":524288 }
```

**Spec của `opencode serve`** `CAUGHT UP` `[SPEC]` (`GET /openapi.json`, 276 535 ký tự):

```
cache_control            : 0 hit
cacheControl             : 0 hit
prompt_cache_key         : 0 hit
cached_tokens            : 0 hit
Model.CacheFormat        : enum ["anthropic", "alibaba"]     ← tồn tại
supportsPromptCacheKey   : có trong Model.Compatibility + Provider.Compatibility
```

Và docs V2 `/v2/docs/providers`: *"OpenCode places prompt-cache breakpoints **automatically** on
routes that are known to need them, such as Anthropic."* Route OpenAI-compatible không thuộc loại đó.

→ OpenCode **không** đặt breakpoint nào cho provider này, vì không ai bảo nó đặt.

### 3.4 Rào thứ ba: `/generate` không có chỗ để móc, và hình dạng prompt giết cache

Đây là phần không nằm trong tài liệu nào, phải suy luận. `INFERRED`, nhưng chuỗi lập luận đầy đủ:

**Rào (a) — transport.** `POST /api/session/{id}/generate` có `additionalProperties: false` và
chỉ nhận `{ prompt: string }`. Không có `messages`, không có `tools`, không có `cache_control`,
không có `prompt_cache_key`, không có `prompt_cache_options`. Gửi field lạ → **400**, không phải
bị bỏ qua. Đã xác nhận ở `RESEARCH-opencode-api.md` §4; tôi đếm lại: 0 hit trên toàn spec.

**Rào (b) — provider.** Không `cacheFormat`, không `supportsPromptCacheKey`, `cost.cache = 0/0`.

**Rào (c) — hình dạng.** Giả sử cả (a) và (b) được mở. `buildTranscript()` nối **mọi thứ thành một
chuỗi duy nhất**: system + schema + protocol + hội thoại + closer, rồi `runModel()` gửi
`{ prompt: promptText }`. Cổng OpenAI-compatible sẽ biến chuỗi đó thành **một message user duy nhất**.

Theo luật lookup của OpenAI, breakpoint implicit nằm ở **cuối message**, và lookup chỉ quét
"các message ending trước đó". Với **một** message, **không tồn tại message ending nào trước đó**.
Turn N ghi cache ở cuối message 43k token. Turn N+1 có message 45k token, 43k token đầu giống hệt,
nhưng endpoint của nó là 45k → **hash khác**. Không có breakpoint nào ở giữa.

→ **Dù cổng có cache, kiến trúc prompt hiện tại vẫn cho tỉ lệ tái sử dụng ≈ 0.**
Đây là lý do `RETRY_HINTS` / `correctionFor` gắn vào **cuối** chuỗi (đúng chỗ) chưa đủ: chỗ đó
không phải vấn đề. Vấn đề là không có **ranh giới** nào ở trong.

Cùng lập luận, áp cho Anthropic: hierarchy `tools` → `system` → `messages` cũng không cứu được,
vì bridge gửi `tools` dưới dạng text bên trong message đầu tiên → nó nằm ở **tầng `messages`**
chứ không phải tầng `tools`.

### 3.5 Kết luận Q2

| Câu hỏi | Trả lời | Mức |
| --- | --- | --- |
| Cổng OpenAI-compatible có tôn trọng `cache_control` của Anthropic không? | **Không hợp lý** — định dạng request khác hẳn. | UNVERIFIED (nhưng suy luận rất mạnh) |
| Cổng có OpenAI-style automatic prefix caching không? | Có thể có. **Không đo được mà không tốn token.** | UNVERIFIED |
| OpenCode có đặt breakpoint cho provider này không? | **Không** — không có `cacheFormat`, route không "known to need them". | CAUGHT UP |
| `space-bunny-free` có `supportsPromptCacheKey` không? | **Không.** | CAUGHT UP |
| Cache có giảm quota free tier không? | OpenAI: **không**, token cache vẫn tính vào TPM. OpenCode: **không biết**. | SPEC-EXT / UNVERIFIED |
| `42k → ~1k` có khả thi không? | **Không.** Ba rào độc lập ở §3.4. | CAUGHT UP + INFERRED |

**Hệ quả thực tế:** `usage.cacheRead: 0` trong `runModel()` **đúng**, và `FIXED_OVERHEAD_TOKENS`
phải tiếp tục giả định không có cache. **Đừng** bật `warming` (xem §7.1).

---

## 4. Q1 — Giảm token cho tool schema

### 4.1 Câu trả lời trực tiếp: Anthropic khuyến nghị **mô tả DÀI**, không phải ngắn

Đây là điểm ngược với trực giác phổ biến, và tài liệu nói rõ:

`CAUGHT UP` `[DOC]` <https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools>,
mục *Best practices for tool definitions*:

> **Provide extremely detailed descriptions.** This is by far the most important factor in tool
> performance. […] **Aim for at least 3–4 sentences for each tool description**, more if the tool
> is complex.

Trang đó còn đặt cạnh nhau hai ví dụ và ghi:
*"The good description clearly explains what the tool does, when to use it, what data it returns,
and what the `ticker` parameter means. **The poor description is too brief and leaves Claude with
many open questions.**"*

`CAUGHT UP` `[BLOG1]` <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
(29/09/2025) nói thẳng điểm mấu chốt khi người ta hiểu "minimal" là "short":

> "you should be striving for the **minimal set of information that fully outlines** your expected
> behavior. (**Note that minimal does not necessarily mean short**; you still need to give the
> agent sufficient information up front…)"

→ **Không có tài liệu chính thức nào của Anthropic khuyến nghị "keep tool descriptions short".**
Ngược lại, blog Engineering nói *"Even small refinements to tool descriptions can yield dramatic
improvements"* và ghi nhận SWE-bench Verified đạt SOTA **nhờ** tinh chỉnh mô tả tool
(`CAUGHT UP` `[BLOG1]`).

**Kết luận cho bridge:** rút ngắn `description` của tool để tiết kiệm token là **đi ngược khuyến
nghị chính thức**, và ở đây còn tệ hơn bình thường vì bridge đã phải chống chịu một hệ vực địa
danh thứ hai (system prompt của OpenCode dạy tên `shell`/`read`/`write`). Cắt mô tả làm tình huống
đó tệ thêm.

### 4.2 Cái Anthropic **thực sự** khuyến nghị cắt: **ít tool hơn**

`CAUGHT UP` `[DOC]` *Define tools*:

> **Consolidate related operations into fewer tools.** Rather than creating a separate tool for every
> action (`create_pr`, `review_pr`, `merge_pr`), group them into a single tool with an `action`
> parameter. **Fewer, more capable tools reduce selection ambiguity** and make your tool surface
> easier for Claude to navigate.

`CAUGHT UP` `[BLOG1]` *Effective context engineering*:

> "One of the most common failure modes we see is **bloated tool sets** that cover too much
> functionality or lead to ambiguous decision points about which tool to use. […] curating a
> **minimal viable set of tools**…"

Nhưng: **Claude Code gửi 23 tool và bridge không có quyền bỏ tool** — Claude Code là client,
`body.tools` là danh sách nó đòi. Xem §4.4.

### 4.3 Ngưỡng định lượng: khi nào tool nhiều thực sự thành vấn đề

`CAUGHT UP` `[BLOG1]` *Introducing advanced tool use* (24/11/2025) — bảng số đo thật:

| Server | Số tool | Token định nghĩa |
| --- | ---: | ---: |
| GitHub | 35 | ~26 000 |
| Slack | 11 | ~21 000 |
| Sentry | 5 | ~3 000 |
| Grafana | 5 | ~3 000 |
| Splunk | 2 | ~2 000 |
| **Tổng** | **58** | **~55 000** |

> "At Anthropic, we've seen tool definitions consume **134K tokens** before optimization."

Và kết quả đo với Tool Search Tool:

| Cách | Token trước khi làm việc |
| --- | ---: |
| Truyền thống (50+ tool MCP) | ~72 000 (tổng ~77 000) |
| Tool Search (search tool ~500 + 3–5 tool ~3 000) | **~8 700** |
| | **giảm 85%**, giữ lại 95% context |

Độ chính xác chọn tool trên MCP eval: **Opus 4: 49% → 74%**; **Opus 4.5: 79.5% → 88.1%**.

`CAUGHT UP` `[DOC]` *Tool search tool* — ngưỡng dùng:

> **Dùng khi:** có **≥ 10 tool**; định nghĩa tool **> 10k token**; độ chính xác chọn tool giảm;
> gộp nhiều MCP server (200+ tool).
> **Ít lợi khi:** < 10 tool; mọi tool đều dùng mỗi phiên; định nghĩa tool gọn (< 100 token tổng).

Và điểm quan trọng cho **chất lượng**, không chỉ token:

> "Claude's ability to pick the right tool **degrades once you exceed 30–50 available tools**."

**Đối chiếu bridge:** 23 tool. Dưới ngưỡng 30–50 → **độ chính xác chọn tool không phải vấn đề chính**.
Còn "định nghĩa tool > 10k token" thì **không biết** — cần đo (P3).

`CAUGHT UP` `[DOC]` *Tool use overview* — chi phí hệ thống prompt do tool use, để so sánh với
~7k của OpenCode: **286–675 token** tuỳ model. Tức là phần "system prompt + danh sách tool" của
Anthropic chỉ khoảng 300–700 token, còn schema mới là phần nặng.

### 4.4 Vì sao **không** lọc danh sách tool ở phía bridge

`CAUGHT UP` `[DOC]` — nhưng kết luận là `INFERRED`:

- Bộ lọc bất kỳ nào cũng phải giữ mọi tool mà `tool_choice` có thể ép (`{type:"tool", name}`).
- Bộ lọc sai một tool ⇒ `resolveToolName` trả `null` ⇒ rơi vào nhánh `names` ⇒ **một lượt retry
  đầy đủ** = 43k token.
- Theo §2.3, 27.4% turn **đã** retry. Nếu bộ lọc làm thêm 5% turn rơi vào nhánh đó, chi phí tăng
  ~2 150 token/turn trung bình, trong khi tiết kiệm được phần schema bị cắt — nhiều khả năng **âm**.
- Thêm: bộ lọc phụ thuộc ngữ cảnh turn ⇒ **phá vỡ tính ổn định của prefix**, tức là phá cache nếu
  sau này cache được bật (xem bảng "cái làm hỏng cache" §3.1: sửa định nghĩa tool mất toàn bộ cache).

→ **Không lọc tool.** Đây là đề xuất có tỉ lệ tiết kiệm/rủi ro **tệ nhất** trong toàn bộ file.

### 4.5 `input_examples` — tốn token nhưng đổi được accuracy

`CAUGHT UP` `[DOC]` + `[BLOG1]`:

- Giá: **~20–50 token** ví dụ đơn giản; **~100–200 token** cho object lồng phức tạp.
- Đổi lại: accuracy trên xử lý tham số phức tạp **72% → 90%** (đo nội bộ Anthropic).
- Blog: *"Keep it concise: **1–5 examples per tool**. Focus on ambiguity."*

`CAUGHT UP` `[DOC]` *Troubleshooting tool use* cũng chỉ `input_examples` là một trong hai cách sửa
"Claude calls with wrong parameter types" (cách kia là `strict: true` — không dùng được ở đây).

→ Ước lượng: 23 tool × 2 ví dụ × 35 token ≈ **1 600 token/turn**. Đắt. Nhưng nó tấn công đúng
nhánh lỗi `schema` mà `validateInput` + retry đang trả giá 43k/lượt.
**Chỉ nên thêm cho tool có hình dạng lồng** — `TodoWrite`, `AskUserQuestion`, `Edit` (vì
`old_string`/`new_string`/`replace_all` dễ lẫn). Ước lượng 3 tool × 2 ví dụ ≈ **210 token/turn**
để đổi một nhánh retry. Đây là **P4.5** trong bảng xếp hạng cuối, không phải P1.

### 4.6 Nén JSON schema mà không mất thông tin

Những khoá **không** dùng và **không** giúp model:

| Khoá | Bridge có dùng? | Nên gỡ khỏi bản render? |
| --- | --- | --- |
| `$schema`, `$comment`, `title`, `examples`, `default`, `deprecated`, `readOnly`, `writeOnly` | Không | **Có** |
| `type`, `properties`, `required`, `additionalProperties`, `enum`, `items`, `anyOf`/`oneOf`, `nullable`, `minItems`/`maxItems` | **Có** (`validateInput`) | **Không** — gỡ là mất cả tín hiệu lẫn validator |

`INFERRED` — chưa đo được mức tiết kiệm, cần P3. Nhưng đây là thay đổi **zero-risk** về hành vi:
khoá bị gỡ không có trong `validateInput`, và model cũng không dùng nó để quyết định.

---

## 5. Q3 — Giảm chi phí retry

### 5.1 Quy mô vấn đề (đo được)

`CAUGHT UP` `[MEAS]` — xem §2.3:

```
retry tax = 471 340 token = 34.1% tổng input token, trên 62 turn
17/62 turn (27.4%) cần ≥ 2 lượt
mỗi lượt thừa = một lần gửi lại TOÀN BỘ transcript
```

So sánh với mọi đề xuất giảm schema ở §4: chúng cắt được vài nghìn token **mỗi lượt**;
retry cắt được **một phần ba tổng số token**. Đây là hàng đầu bảng xếp hạng.

### 5.2 Ba chiến lược trong đề bài, đánh giá thẳng

**(a) Rút gọn transcript khi retry** → **Nên làm. Đây là P2.**

**(b) Retry với prompt ngắn hơn** → là một biến thể của (a). Ràng buộc quan trọng:

`CAUGHT UP` `[PAPER]` (đã dẫn ở `RESEARCH-json-reliability.md` §5.2): model nhỏ sau khi nhận
feedback có xu hướng **lặp lại lỗi cũ** thay vì hồi phục. Nếu lượt retry có **ít context hơn**,
mô hình dễ lại chọn sai tên tool hơn — tức là **tăng** xác suất cần lượt thứ ba.

→ Nguyên tắc: **giữ nguyên hoặc tăng tính cụ thể của lượt retry; chỉ cắt những phần không liên
quan tới việc sửa lỗi hiện tại.**

**(c) Chỉ gửi phần thay đổi** → **Không làm được, và làm được cũng sai.**

`CAUGHT UP` `[SPEC]` — `/generate` là completion **transient**, không ghi lịch sử session. Model
**không có ký ức gì** về lượt trước. Nên "chỉ gửi phần thay đổi" tức là model không biết nó đã
trả lời sai gì.

`CAUGHT UP` `[DOC]` *Handling stop reasons* cảnh báo đúng cái bẫy này:

> "Don't retry empty responses without modification: Sending the empty response back won't help."

Bridge **đã tuân thủ** ở mức tối thiểu: `correctionFor()` ghi rõ loại lỗi (đúng khuyến nghị
*"Write instructive error messages"* của Anthropic). Cấu trúc bắt buộc mới là: **gửi lại prompt
đầy đủ + chỉ dẫn sửa**, không phải delta.

### 5.3 Cấu trúc chi tiêu của một lượt retry

Cái được gửi ở attempt *k* (`bridge.mjs` dòng 1589):

```js
runModel(transcript + RETRY_HINTS[attempt] + retryNote, …)
```

Nghĩa là **toàn bộ** 43k + một chỉ dẫn ~300–600 ký tự. Về mặt kỹ thuật, phần có thể cắt:

| Cắt được | Cắt bao nhiêu | Rủi ro |
| --- | ---: | --- |
| `description` của từng tool (giữ `name` + `input_schema`) | **Chưa biết** — cần P3 | Thấp ở lượt retry: model đã chọn tool rồi, chỉ sai *tên*/*shape*, không cần đọc mô tả để sửa |
| Tool không liên quan tới lỗi đang sửa | Không biết | Trung bình |
| Tool result cũ đã xử lý xong (xem P1) | **~20–29k** | Trung bình |
| `RESPONSE_PROTOCOL` + closer (~973 token) | ~973 | **Cao** — xem dưới |

Về việc **không** cắt protocol ở lượt retry: `RETRY_HINTS` và `correctionFor` đều dựa trên tiền đề
rằng model hiểu envelope; bỏ định nghĩa envelope ở đúng lượt mà model vừa phá vỡ envelope là
đánh đổi rủi ro lớn nhất lấy 973 token (2.3% của turn 43k).

### 5.4 Một cải tiến không tốn token: cho lượt 2 biết nó đã bị nhắc

`CAUGHT UP` `[PAPER]` — `RETRY_HINTS[2]` là hằng số theo chỉ số attempt, nên attempt 2 không biết
nó **đã** được nhắc một lần. Chi phí: **0 token/turn ở attempt 0**, vài chục token ở các lượt
sau. Đây là đề xuất **P0** về giá trị/công sức. (Đã được `RESEARCH-json-reliability.md` N4 nêu;
nhắc lại vì nó nằm đúng trong câu hỏi này.)

---

## 6. Q4 — Nén transcript

### 6.1 Anthropic khuyến nghị gì (chính thức)

**A. Tool result clearing — tính năng API.** `CAUGHT UP` `[DOC]`
<https://platform.claude.com/docs/en/build-with-claude/context-editing>

Beta header `context-management-2025-06-27`, chiến lược `clear_tool_uses_20250919`:
API tự **xoá các tool result cũ nhất theo thứ tự thời gian** khi context vượt ngưỡng, thay bằng
placeholder. Cấu hình:

```jsonc
{ "type": "clear_tool_uses_20250919",
  "trigger":       { "type": "input_tokens", "value": 30000 },
  "keep":          { "type": "tool_uses",  "value": 3 },   // giữ 3 tool use gần nhất
  "clear_at_least":{ "type": "input_tokens", "value": 5000 },
  "exclude_tools": ["web_search"] }
```

Doc nói rõ **vì sao đúng loại này**:

> "Older tool results (like file contents or search results) are **no longer needed once Claude has
> processed them**."

**B. Trong blog Engineering.** `CAUGHT UP` `[BLOG1]`:

> "An example of low-hanging superfluous content is **clearing tool calls and results** – once a
> tool has been called deep in the message history, why would the agent need to see the raw result
> again? **One of the safest lightest touch forms of compaction** is tool result clearing."

**C. Tham chiếu định lượng của chính Claude Code.** `CAUGHT UP` `[BLOG1]` *Writing effective tools
for agents*:

> "We suggest implementing some combination of **pagination, range selection, filtering, and/or
> truncation** with sensible default parameter values for any tool responses that could use up lots
> of context. **For Claude Code, we restrict tool responses to 25,000 tokens by default.**"

⚠️ **Đây là sai lệch đơn vị mà bridge đang mắc kẹt.** Claude Code giới hạn **25 000 *token***.
`bridge.mjs` giới hạn `TOOL_RESULT_CAP = 24 000` **ký tự** ≈ **8 570 token** — **chặt hơn tham
chiếu 2.9×**. Và `TOOL_RESULT_BUDGET = 160 000` ký tự ≈ **57 100 token** tổng, so với mức
`clear_tool_uses` mặc định kích hoạt ở **30 000 token**. Bridge đang ở trạng thái ngược: **chặt
quá mức ở trần, và không có trần theo tuổi**.

**D. Nguyên tắc chung.** `CAUGHT UP` `[BLOG1]`:

> "Context, therefore, must be treated as a **finite resource with diminishing marginal returns**. […]
> good context engineering means finding the **smallest** possible set of high-signal tokens that
> maximize the likelihood of some desired outcome."

Và phần **nén**, không phải xoá:

> "Compaction distills the contents of a context window in a high-fidelity manner […] The model
> preserves architectural decisions, unresolved bugs, and implementation details while discarding
> **redundant tool outputs**."

**E. Sub-agent như một hình thức nén.** `CAUGHT UP` `[BLOG1]`:

> "Each subagent might explore extensively, using **tens of thousands of tokens** or more, but
> returns only a condensed, distilled summary of its work (often **1,000–2,000 tokens**)."

→ Tỉ lệ nén ~**20–50×**. Bridge **không** dùng được: `/generate` không có kênh tool, và `Task`
bị chủ động loại khỏi alias (lý do an toàn đã ghi trong `TOOL_ALIASES`).

### 6.2 Bằng chứng rằng context dài **làm hỏng** chất lượng (không chỉ tốn tiền)

`CAUGHT UP` `[BENCH]` <https://research.trychroma.com/context-rot> — Chroma Technical Report,
14/07/2025, 18 model (GPT-4.1, Claude 4, Gemini 2.5, Qwen3…):

- "Across all experiments, **model performance consistently degrades with increasing input length**."
- Distractor có tác động **không đồng đều**, và **khuếch đại** khi input dài hơn.
- LongMemEval: prompt **tập trung** (~300 token) vs prompt **đầy đủ** (~113k token) —
  "significantly higher performance on focused prompts compared to full prompts", trên **mọi** họ model.
- Cấu trúc: "models perform better on **shuffled** haystacks than on logically structured ones."
- Giới hạn mà báo cáo tự thừa nhận: đây là **retrieval**, không phải agentic loop.

→ **Không có nghiên cứu nào đo trực tiếp tác động của việc *stub* tool result (khác với *truncate*)
trên một agent loop.** Đây là khoảng trống thật; mọi con số dưới đây là **INFERRED**, phải đo tại
chỗ.

### 6.3 Bridge hiện tại: không có khái niệm "tuổi" của tool result

`CAUGHT UP` `[MEAS]` — đọc `buildTranscript()`:

- Có `TOOL_RESULT_CAP` (mỗi result) và `TOOL_RESULT_BUDGET` (tổng mỗi turn).
- **Không có** gì theo dõi *tool result nào đã cũ*. Mọi result đều được xử lý như nhau, theo thứ tự
  xuất hiện, tới khi hết ngân sách.

Đây chính là khoảng trống mà `clear_tool_uses_20250919` lấp. Và nó là **thay đổi rủi ro thấp nhất**
trong toàn bộ file, vì nó **không chạm** vào phần prompt đang giữ model ổn định (protocol, schema,
thứ tự block) — chỉ thay nội dung của các block đã cũ.

### 6.4 Trade-off của P1 (bảng câu hỏi/đáp án)

| Rủi ro | Mức | Giảm thiểu |
| --- | --- | --- |
| Model cần nội dung file cũ để trả lời, không thấy nữa | **Cao nhất** | Stub phải ghi **lệnh đọc lại** cụ thể, không phải "đã bị xoá". Anthropic: *"be sure to steer agents with helpful instructions"* |
| Stub tiếp tục ăn ngân sách `TOOL_RESULT_BUDGET` | Thấp | Stub ~120 ký tự; phải đặt ngoài phần trừ ngân sách để không bị cắt |
| Model lặp lại lệnh đã chạy để lấy lại dữ liệu | Trung bình | `exclude_tools` tương đương: **không stub `Read`/`Grep`/`Glob`** — chỉ stub kết quả không idempotent và không có lệnh tái tạo rẻ (`Bash`, `WebFetch`) |
| Prompt ngắn lại làm model mất mạch | Thấp | Chỉ xoá, không **nén**; nếu nén thì phải theo "start by maximizing recall" mà Anthropic nêu cho compaction |

---

## 7. Q6 — Chi phí ẩn khác (góc mới, không lặp lại `RESEARCH-opencode-api.md`)

### 7.1 `warming` — công cụ giữ cache của OpenCode, và vì sao **không** bật

`CAUGHT UP` `[DOC]` <https://opencode.ai/v2/docs/warming> (mới, không có trong `RESEARCH-opencode-api.md`):

> "Session warming sends periodic model requests to **preserve provider-side prompt caches** or other
> short-lived state while you pause between prompts. It is **disabled by default**."

Cấu hình: `{ prompt, interval: "4 minutes", duration: "30 minutes" }` (schema đọc từ
`Config.WarmingEncoded` trong `openapi.json` — xác nhận).

Hai kết luận:

1. **Góc mới:** OpenCode *tự thừa nhận* khái niệm "provider-side prompt cache". Warming là bằng
   chứng gián tiếp rằng đường OpenAI-compatible **có thể** có cache và cần được giữ ấm. Nhưng
   `warming` dùng **session context** — mà `/generate` không có session history ⇒ **vô dụng với
   bridge**. Không dùng được.
2. **Chi phí:** docs nói thẳng *"Warming requests are real provider requests. They can consume
   tokens, incur costs, **count against rate limits**"*, mặc định tối đa **7** request mỗi cửa sổ
   30 phút. Trên free tier bị rate limit, đây là **rủi ro không đổi lại lợi ích**.
   → **`warming: false`. Đừng bật.**

### 7.2 `compatibility.cacheFormat` — đường duy nhất còn lại (rủi ro cao, UNVERIFIED)

`CAUGHT UP` `[SPEC]`: `Model.CacheFormat = enum ["anthropic", "alibaba"]`, khai báo được ở
`Provider.Compatibility` và `Model.Compatibility`. Không có model nào của provider `opencode`
dùng nó (đã kiểm cả 10 model — `CAUGHT UP` `[MEAS]`).

Giả thiết: đặt `providers.opencode.compatibility.cacheFormat = "anthropic"` khiến OpenCode chèn
`cache_control` vào request. **Nhưng request đó đi tới một endpoint OpenAI-compatible**, nên:

- Nếu cổng bỏ qua field lạ → **không có tác dụng gì**.
- Nếu cổng validate chặt → **mọi request 400**, bridge chết.
- Nếu cổng hiểu → có thể có cache, nhưng §3.4 rào (c) vẫn giữ nguyên: một message duy nhất ⇒ không
  có breakpoint.

→ **Không làm.** Lý do: xác suác đồng thời *(cổng hiểu field)* × *(cổng chịu được)* × *(tạo được
boundary trong một chuỗi)*, trong khi phần thưởng là **0 token** vì `cost = 0`. Đây là một canary
tốn token để mua thông tin, không phải một tối ưu.

### 7.3 `encoding` và `transport` — tiết kiệm **bytes**, không phải token

`CAUGHT UP` `[DOC]` `/v2/docs/providers`:

- `settings.encoding: "zstd" | "gzip" | "none"` — nén body HTTP.
- `settings.transport: "websocket"` — *"Consecutive steps reuse the unchanged request prefix and
  only send content added since the previous response, reducing uploads in long sessions."*

Cả hai đều **không giảm token** (model vẫn xử lý 43k). Chúng giảm **băng thông và thời gian upload**.
Ở đây body là JSON khoảng 120 KB gửi mỗi lượt qua loopback → không phải nút thắt.

Một điểm đáng chú ý về `websocket`: *"only send content added since the previous response"* —
đó chính là cơ chế cache-prefix ở tầng vận chuyển. Nó chỉ khả dụng cho route có session history
(`/prompt`), không phải `/generate`. `INFERRED`.

### 7.4 `tool_output` của OpenCode — tham chiếu để hiệu chỉnh

`CAUGHT UP` `[DOC]` `/v2/docs/config`:

```jsonc
{ "tool_output": { "max_lines": 2000, "max_bytes": 51200 } }
```

Đây là trần tool result của **OpenCode** (khi dùng `/prompt`), không phải của bridge. Nhưng nó là
mốc thứ hai để so: OpenCode chọn **50 KB**, Claude Code chọn **25 000 token ≈ 90 KB**, bridge chọn
**24 000 ký tự**. Ba con số khác nhau, cùng một bài toán, không có chuẩn nào ủng hộ.

### 7.5 Over-report `input_tokens` → compact sớm → **tốn thêm token**

`INFERRED` — chưa đo. Chuỗi lập luận:

1. `usageBlock()` báo `input_tokens` cho Claude Code; Claude Code **cộng dồn** vào bộ đếm context
   của nó (README đã ghi nhận).
2. Claude Code tự compact khi bộ đếm đó vượt `autoCompactWindow`.
3. `tokensSpent` = **tổng của cả các lượt retry**. Với 27.4% turn retry (đo được), con số báo ra
   cao hơn context thật của lượt cuối.
4. → Bridge báo **thừa** context ⇒ Claude Code compact **sớm hơn cần thiết** ⇒ nhiều turn hơn ⇒
   **tổng token cao hơn**.

Khắc phục nếu muốn kiểm chứng: báo `input_tokens` của **chỉ lượt cuối** (`usage.input` thay vì
`tokensSpent`) và ghi `tokens_spent` thật vào log để so. Đánh đổi: báo cáo usage không còn
phản ánh trung thực — README hiện coi đó là một tính năng. **Để người dùng quyết định.**

### 7.6 Bỏ `AGENTS.md` khỏi thư mục dự án

`CAUGHT UP` — `Config.InfoEncoded` của V2 có khoá `instructions` và `references`
(`[SPEC]`, đếm trong `openapi.json`). Docs `/v2/docs/config`: *"Declare additional instruction files,
globs, or HTTP(S) URLs. OpenCode loads them alongside discovered `AGENTS.md` files."*

`AGENTS.md` trong thư mục hiện tại được nạp vào mọi completion — tức là **tiết kiệm được token
bằng cách không có file đó ở đó**, không phải bằng cách sửa bridge. `INFERRED` về chiều lượng
(cần đo), `CAUGHT UP` về cơ chế.

---

## 8. Q5 — Ước lượng token chính xác

### 8.1 Tokenizer thay đổi theo phiên bản — hằng số không phải hằng số vũng

`CAUGHT UP` `[DOC]` *Token counting*:

> "Claude 4.7 and later models and Claude Mythos Preview use a newer tokenizer. **The same input
> text produces approximately 30 percent more tokens** than on earlier models. The exact increase
> depends on the content and workload shape. **Recount prompts against the model you plan to use
> rather than reusing counts measured against earlier models.**"

→ `CHARS_PER_TOKEN` là hằng số **phụ thuộc model + version**. `space-bunny-free` không công bố
tokenizer ⇒ **không có con số chính thức nào cho model này.** `UNVERIFIED`.

### 8.2 `2.8` hiệu chỉnh tốt cho văn xuôi — đã kiểm chứng bằng log

`CAUGHT UP` `[MEAS]` (§2.1): sàn cố định 2 824 ký tự → 1 009 token = **2.80 chars/token**, khớp với
hằng số đang đặt. Với **văn xuôi tiếng Anh không dấu**, `2.8` gần như chính xác.

### 8.3 Nhưng JSON **đặc hơn**, và 2.8 **sai theo hướng nguy hiểm**

`INFERRED` — không đo được ở đây vì không có tokenizer thật cho `space-bunny-free`:

JSON đóng gói có nhiều ký tự cấu trúc (`{`, `}`, `"`, `:`, `,`) được tokenizer gộp thành token
ngắn, nên **chars/token thấp hơn** văn xuôi. Hệ quả trực tiếp:

| Vùng | chars/token thực | Ước lượng @2.8 | Lệch |
| --- | ---: | ---: | --- |
| `RESPONSE_PROTOCOL`, closer, hội thoại (văn xuôi) | ~2.8 | chính xác | ~0 |
| `JSON.stringify(toolSpec)` (schema) | **~2.0–2.3** | **thừa ~20–40%** | **QUÁ thận trọng** |
| `JSON.stringify(b.input)` trong tool_use | ~2.2 | thừa ~25% | quá thận trọng |

Hai hệ quả **ngược nhau**, và điều thứ hai mới là vấn đề:

1. **Guard overflow**: dùng 2.8 nghĩa là ước lượng **cao hơn thực** ⇒ `EFFECTIVE_INPUT_LIMIT` kích
   hoạt **sớm hơn** thật ⇒ Claude Code compact sớm ⇒ **tốn thêm token** theo §7.5. Đây là chi phí
   thật, và nó đúng ở **vùng lớn nhất** của prompt.
2. **Usage báo ra**: `usageBlock()` báo token cao hơn thật. Vô hại nếu Claude Code chỉ hiển thị;
   có hại nếu nó dùng để quyết định compact.

→ Đề xuất P4: **tách ước lượng theo vùng**, không dùng một hằng số cho mọi thứ:

```js
// minh hoạ — hằng số chưa hiệu chỉnh, xem §8.4
function transcriptTokens(t) {
  return Math.ceil(t.length / 2.8);           // văn xuôi: giữ nguyên, đã đo
}
// và: khi gọi cho JSON, dùng / 2.2
```

Rủi ro: hằng số 2.2 **chưa được đo** trên model này. Nếu đặt quá thấp thì guard **không** bắt được
overflow ⇒ 503 "invalid request" giữa chừng thay vì 400 sạch. Đó là lý do §8.4 bắt buộc phải đo
trước.

### 8.4 Cách hiệu chỉnh mà không cần tokenizer thật

`CAUGHT UP` `[DOC]` *Token counting*: Anthropic có `POST /v1/messages/count_tokens` —
**miễn phí**, tác rate limit riêng, "**Token counting and message creation have separate and
independent rate limits. Usage of one does not count against the limits of the other.**"

→ Đây là con đường hiệu chỉnh **đúng**, nhưng nó cần một API key Anthropic trả tiền, và chỉ đo
được trên **model Anthropic**, không phải `space-bunny-free`. Nó cho bạn một con số
chars/token *tham chiếu*, không phải con số của model này. `INFERRED` — hữu ích để đặt giới hạn
trên/dưới, **không** thay thế được phép đo tại chỗ.

**Phép đo tại chỗ duy nhất đáng tin** (`UNVERIFIED`, cần token):

> `/generate` **không trả usage** (`CAUGHT UP` `[SPEC]`: response = `{data:{text}}`,
> `additionalProperties:false`). Không có con đường nào để bridge biết token thật.

Nên lộ trình khả thi, tự trả phí bằng chính lượt đầu tiên:

1. Chọn 3 mẫu transcript có kích thước khác nhau từ `bridge.log`.
2. Đo `chars` chính xác bằng `POST /debug/transcript` (endpoint debug của bridge, không gọi model).
3. Chạy **một** lượt thật cho mỗi mẫu, lấy token thật từ… **không có nguồn**.

→ **Không có cách nào.** Đây là hạn chế kiến trúc, không phải thiếu sót có thể sửa. Cách duy nhất
là đổi transport sang `/prompt` (`RESEARCH-opencode-api.md` §8.2), nơi `Session.Message.Assistant`
có `tokens`. Đó là lý do **P4 hạ mức ưu tiên**: cải thiện ước lượng không cắt được token nào;
nó chỉ làm guard và báo cáo usage chính xác hơn.

Ngoại lệ thực dụng: **dùng chính Claude Code làm chuẩn.** Claude Code gửi `count_tokens` tới
bridge (`bridge.mjs` dòng 2071). Nếu Claude Code có một đường nào đó lấy usage thật từ provider
gốc thì đó là dữ liệu miễn phí. **Không biết** (`UNVERIFIED`) — cần kiểm tra binary `claude.exe`.

### 8.5 `OUT_CHARS_PER_TOKEN = 3.2` — chỉ dùng để cắt output

`CAUGHT UP` `[MEAS]` — chỗ dùng: `runModel()` cắt `text` theo `max_tokens * OUT_CHARS_PER_TOKEN`,
và `handleMessages` cắt block theo `maxTokens * OUT_CHARS_PER_TOKEN`. Cả hai đều là **ngân sách
ký tự**, không phải ước lượng token.

Rủi ro ở đây là **ngược**: 3.2 **lớn hơn** chars/token thật của output văn xuôi (~2.8), nghĩa là
ngân sách ký tự **hào phóng** ⇒ cắt **ít hơn** ⇒ báo `output_tokens` thấp hơn thật. Đây là hướng
an toàn (không cắt nhầm tool_use), và README đã nêu đúng lý do. **Giữ nguyên.**

---

## 9. Hệ quả cho `bridge.mjs` — theo (token tiết kiệm) / (rủi ro)

Xếp theo **giá trị/công sức**, không theo token. Mỗi mục ghi rõ có dùng được không.

---

### **P3 — Đo khối tool schema, trước khi động vào nó** · *chi phí 0 token · rủi ro ~0 · **làm trước mọi thứ khác***

Mọi con số ở P1/P2/P6 đều gắn với "khối tool schema lớn cỡ nào", và con số đó **chưa ai đo**.
Đo nó trong 1 phút, không tốn token:

```powershell
# gửi một body Claude Code thật (bắt từ bridge.log / debug) vào endpoint debug
irm -Method POST http://127.0.0.1:8787/debug/transcript -ContentType 'application/json' -BodyFile body.json
# rồi đếm riêng khối JSON schema:
```

Trong `buildTranscript`, khối schema là **một dòng** `JSON.stringify(toolSpec)`. Đo độ dài dòng đó
chia cho `tools.length`, rồi trừ sàn 1 009 (§2.1) khỏi `prompt_tokens` trong `bridge.log`
để ra tổng của **system prompt Claude Code + schema + tin nhắn user**.

Ba kết quả có thể xảy ra, và mỗi kết quả đổi khuyến nghị:

| Kết quả | Hành động |
| --- | --- |
| Schema > 10 000 token | Vượt ngưỡng chính thức của Anthropic cho tool search (§4.3). P6 trở nên đáng cân nhắc. |
| Schema 5–10k token | Chỉ P1 + P2 + P4. **Không** đụng schema. |
| Schema < 5k token | P1 là toàn bộ câu chuyện. P2/P6 bỏ. |

**Rủi ro:** không có. Đây là `GET /debug/transcript` của chính bridge.

---

### **P1 — Stub tool result cũ thay vì cắt bằng ngân sách** · *tiết kiệm lớn nhất · rủi ro trung bình · đúng khuyến nghị chính thức*

**Căn cứ:** `CAUGHT UP` `[DOC]` `clear_tool_uses_20250919` + `[BLOG1]` "one of the safest lightest
touch forms of compaction".

**Ước lượng** (`INFERRED`, chỉ hợp lệ sau P3):

Với `TOOL_RESULT_BUDGET = 160 000` ký tự ≈ **57 100 token** là trần tổng. Nếu một turn sâu có
10 kết quả tool, và ta giữ **3 cái gần nhất đầy đủ**, stub 7 cái cũ:

```
stub 7 × 24 000 = 168 000 → 7 × 120 = 840 ký tự   ⇒ tiết kiệm ~167 000 ký tự ≈ 59 700 token
```

Con số thực tế thấp hơn nhiều vì `share = min(CAP, budget còn lại)` đã giới hạn từng result.
Trường hợp thực tế: turn sâu 43k có khoảng **8–12k token** tool result (phần còn lại là Claude
Code system prompt + schema). Giữ 3 gần nhất + stub phần cũ ⇒ tiết kiệm **~5–9k token/turn**.
Trên turn có ngân sách đầy ⇒ **~40–55k**.

**Cách làm cụ thể** — thêm tuổi vào vòng lặp `buildTranscript`:

```js
// Giữ TOOL_RESULT_KEEP (mặc định 3) tool_result gần nhất ở dạng đầy đủ.
// Các result cũ hơn thay bằng stub, KHÔNG trừ vào resultBudget:
//   <tool_result id="...">[stubbed: 1204 lines of Bash output, 38 KB.
//   Re-run the same command to get it again.]</tool_result>
```

**Bốn ràng buộc bắt buộc** (từ §6.4):

1. **Không stub `Read`/`Grep`/`Glob`.** Chúng idempotent và có lệnh tái tạo rẻ; tương đương
   `exclude_tools` của Anthropic.
2. **Stub phải chứa lệnh tái tạo**, không phải "đã bị xoá". Anthropic: *"be sure to steer agents
   with helpful instructions"* `[BLOG1]`.
3. **Stub không tính vào `TOOL_RESULT_BUDGET`** — nếu tính thì `budget` âm và phần "not shown" của
   `buildTranscript` bắt đầu sớm hơn dự kiến.
4. **Cắt theo ranh giới turn**, không theo byte: một `tool_result` là một đơn vị nguyên tử. Cắt
   giữa chừng khiến model thấy `</tool_result>` không khớp.

**Rủi ro:** model cần dữ liệu cũ và không chạy lại lệnh. Giảm thiểu: `TOOL_RESULT_KEEP` bắt đầu
ở **3**, tăng lên 5 nếu quan sát thấy lỗi. Đây là biến môi trường, không phải hằng số.

---

### **P2 — Rút gọn prompt ở lượt retry** · *34.1% token là retry (đo được) · rủi ro trung bình-thấp*

**Căn cứ:** §5.1 (đo), §5.2 (giới hạn của delta), §5.3 (bảng cái cắt được).

Nguyên tắc bắt buộc từ §5.2(b): **giữ hoặc tăng tính cụ thể, chỉ cắt phần không liên quan.**

Thứ tự cắt, từ an toàn nhất:

1. **Tool result cũ** (giống P1, nhưng áp dụng cả ở attempt 0) — rủi ro thấp nhất.
2. **Bỏ `description` khỏi schema ở `attempt > 0`** — chỉ giữ `name` + `input_schema`.
   Lý do: lượt retry xảy ra khi model **đã chọn** tool và sai *tên* hoặc *shape*; nó không cần
   đọc mô tả để sửa lỗi tên. Tiết kiệm: **chưa biết**, cần P3 (thường là 30–50% khối schema).
3. **Bỏ tool không liên quan tới `kind` hiện tại** — chỉ an toàn khi `kind === "names"`, vì khi đó
   tên hợp lệ đã được liệt kê trong `correctionFor("names")` ngay trong prompt sửa.
4. **KHÔNG cắt `RESPONSE_PROTOCOL` / `FINAL` closer** ở lượt retry — đánh đổi 973 token lấy rủi ro
   phá vỡ envelope đúng lúc model vừa phá vỡ envelope.

Cơ chế: `runModel(transcript + RETRY_HINTS[attempt] + retryNote)` đã là chỗ đúng — thêm một
`renderRetryTranscript(body, attempt)` thay cho `transcript` khi `attempt > 0`.

**Rủi ro:** giảm context ở lượt retry có thể làm tăng xác suất lượt thứ ba (`[PAPER]` 2601.15625).
Bắt buộc đo: log `attempts` theo bận tối đa 3 trước và sau. `bridge.log` đã có đủ trường.

---

### **P0 — `RETRY_HINTS[2]` tham chiếu ngược** · *chi phí 0 token ở attempt 0 · rủi ro ~0*

`RETRY_HINTS[2]` hiện là hằng số theo chỉ số, nên attempt 2 không biết nó đã được nhắc một lần.
Căn cứ: `CAUGHT UP` `[PAPER]` 2601.15625 (lặp lại lỗi sau khi nhận feedback) + 2509.18847.
Đã nêu ở `RESEARCH-json-reliability.md` N4; nhắc lại vì nó nằm đúng trong câu hỏi này và gần như
miễn phí.

**Rủi ro:** chỉ là câu chữ. Không có đường hồi quy nếu không log `attempts`.

---

### **P4 — Ước lượng token tách theo vùng** · *0 token tiết kiệm · rủi ro thấp nếu hiệu chỉnh đúng*

Xem §8.3 và §8.4. **Đây không cắt token nào.** Nó làm (i) `EFFECTIVE_INPUT_LIMIT` bớt thận trọng
quá mức trên JSON — tức là **compact sớm hơn cần thiết**, vốn là chi phí thật (§7.5) — và
(ii) `usage` báo ra chính xác hơn.

**Hạ ưu tiên so với P1/P2** vì không cắt token, chỉ giảm *phần sai* của ước lượng.

**Rủi ro thật:** hằng số JSON chưa đo. Đặt quá thấp ⇒ guard không bắt overflow ⇒ 503 giữa chừng
thay vì 400 sạch. **Không đổi hằng số nếu chưa đo** (P3). Nếu muốn an toàn hơn: dùng hằng số
JSON **chỉ trong `usageBlock()`**, giữ `2.8` trong `EFFECTIVE_INPUT_LIMIT`.

---

### **P4.5 — `input_examples` cho 3 tool hình dằng lồng** · *+210 token/turn · rủi ro rất thấp · đổi được một nhánh retry*

Xem §4.5. `TodoWrite`, `AskUserQuestion`, `Edit`. Bằng chứng đổi chéo: accuracy tham số phức tạp
**72% → 90%** `[BLOG1]`, và "Claude calls with wrong parameter types" là triệu chứng có sẵn trong
bảng chẩn đoán chính thức mà `validateInput` đang bắt hậu kỳ.

**Rủi ro:** tăng 210 token/turn (0.5% của turn 43k). Nếu `probe-behaviour.mjs` không cho thấy giảm
tỉ lệ `badInput`, gỡ bằng cách xoá hẳn — đừng để chúng tồn tại "vì tài liệu bảo vậy".

---

### **P5 — KHÔNG lọc danh sách tool** · *rủi ro cao hơn phần thưởng*

Xem §4.4. Ghi lại ở đây để không ai thử lại.

---

### **P6 — Just-in-time tool loading** · *bằng chứng mạnh, nhưng chưa đáng ở 23 tool*

`CAUGHT UP` — giảm **85%** token định nghĩa tool, Opus 4 accuracy **49% → 74%** (§4.3). Đó là
bằng chứng tốt nhất trong toàn bộ file.

Nhưng hai điều kiện phải đồng thời thoả:

1. **Ngưỡng chính thức:** ≥ 10 tool **và** > 10k token định nghĩa. 23 tool thoả điều kiện đầu;
   điều kiện thứ hai **chỉ biết sau P3**.
2. **Không có kênh tool native.** `/generate` không nhận `tools` hay `tool_choice`
   (`CAUGHT UP` `[SPEC]`). Phải mô phỏng bằng text: catalog rút gọn + một tool giả
   `SCHEMA_REQUEST`. Điều đó **thêm một vòng lượt** và một kiểu thất bại mới — mà theo
   `RESEARCH-json-reliability.md` §4.4, BFCL cho thấy model nhỏ **nhạy cảm với định dạng prompt**
   một cách không dự đoán được.

**Kết luận:** chỉ làm nếu P3 cho thấy schema > 10k token **và** P1/P2 đã được đo là không đủ.
Nếu làm, phải đặt sau cờ và đo `attempts` y như P2.

---

### **P7 — Báo `input_tokens` của lượt cuối, không phải `tokensSpent`** · *rủi ro trung bình, cần quyết định của người dùng*

Xem §7.5. Giả định: báo cáo usage **thừa** làm Claude Code compact sớm hơn cần thiết.

Chưa đo được. Nhưng có thể đo **không tốn token thêm**: bật `BRIDGE_DEBUG=1` chạy một phiên
thật, so `autoCompactWindow` của Claude Code với số turn thực tế.

**Đánh đổi:** README coi *"`usage` luôn mô tả cái thực sự đã gửi"* là một tính năng
(`tokensSpent` cộng dồn). Đổi là phá cam kết đó. **Không tự ý đổi.**

---

## 10. Điều tôi **không biết**

Ghi rõ thay vì đoán.

| Câu hỏi | Vì sao không trả lời được |
| --- | --- |
| Khối tool schema của Claude Code 23 tool là bao nhiêu token? | Cần một body Claude Code thật. Đo được trong 1 phút (P3), chưa làm. |
| Cổng `opencode.ai/inference` có OpenAI-style prefix caching không? | `/generate` không trả usage. Không quan sát được mà không tốn token. |
| Rate limit free tier của OpenCode tính theo TPM hay RPM? | Không có endpoint nào công bố. Nếu TPM thì cache cũng không giúp (§3.2, `[SPEC-EXT]`). |
| `space-bunny-free` dùng tokenizer nào? | Không công bố. `CHARS_PER_TOKEN` chỉ là hằng số thực nghiệm cho **văn xuôi**. |
| chars/token thật của JSON trên model này? | Cần tokenizer hoặc usage thật. Cả hai đều không có. |
| Claude Code có lấy được usage thật từ provider gốc không? | Chưa kiểm tra binary `claude.exe`. Nếu có, đây là con đường **miễn phí** để hiệu chỉnh P4. |
| Bao nhiêu % lượt retry rơi vào từng `kind` cụ thể? | `bridge.log` chỉ ghi `discarded_chars`, không ghi `kind` vào dòng `done`. **Thêm `kind` vào log là bước đầu tiên của mọi đo trong file này.** |
| `system` inject của `opencode serve` là bao nhiêu token chính xác? | `RESEARCH-opencode-api.md` đã đo ~6.7k. `FIXED_OVERHEAD_TOKENS = 12000` là **biên an toàn**, không phải số đo. |

---

## 11. Phụ lục — lệnh dò (chỉ-đọc, **không tốn token**)

```powershell
# 1. Số đo baseline đã có sẵn trên đĩa
$log = ".\bridge.log"
$L = Get-Content $log | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} }
$starts=@{}; foreach($l in $L){ if($l.kind -eq 'start'){ $starts[$l.id]=$l.prompt_tokens } }
$r = $L | Where-Object kind -eq 'done' | ForEach-Object {
  [pscustomobject]@{ attempts=$_.attempts; start=$starts[$_.id]; spent=$_.tokens_spent } } |
  Where-Object { $_.start -gt 0 }
$base=($r|Measure-Object start -Sum).Sum; $spent=($r|Measure-Object spent -Sum).Sum
"retry tax = $($spent-$base) token = $([math]::Round(100*($spent-$base)/$spent,1))% ; turns >1 attempt = $(($r|?{$_.attempts -gt 1}).Count)/$($r.Count)"

# 2. P3 — đo khối tool schema (endpoint debug của chính bridge, không gọi model)
$b = Get-Content .\one-real-claude-code-request.json -Raw     # body Claude Code thật
$json = $b | ConvertFrom-Json
$spec = $json.tools | ForEach-Object {
  @{ name=$_.name; description=$_.description; input_schema=$_.input_schema } } | ConvertTo-Json -Compress
"schema block: $($spec.Length) chars ~= $([math]::Ceiling($spec.Length/2.8)) tokens @2.8"

# 3. Metadata cache của model (CAUGHT UP, không tốn token)
$pw=(Get-Content .\.opencode-password -Raw).Trim()
$H=@{ Authorization='Basic '+[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("opencode:$pw")) }
(irm http://127.0.0.1:4599/api/model -Headers $H).data |
  Where-Object modelID -eq 'space-bunny-free' |
  Select-Object compatibility,cost,limit | Format-List

# 4. Spec: các khoá liên quan cache (0 hit = không có đường)
$s=(irm http://127.0.0.1:4599/openapi.json -Headers $H).Content
'cache_control','cacheControl','prompt_cache_key','cached_tokens','cacheFormat','supportsPromptCacheKey' |
  ForEach-Object { "{0,-24}{1}" -f $_,([regex]::Matches($s,[regex]::Escape($_))).Count }
```

---

## 12. Phụ lục — nguồn

### Tài liệu chính thức `[DOC]`

| Trang | URL | Dùng cho |
| --- | --- | --- |
| Prompt caching | <https://platform.claude.com/docs/en/build-with-claude/prompt-caching> | §3.1 |
| Tool use with prompt caching | <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching> | §3.1, §3.4 |
| Context editing | <https://platform.claude.com/docs/en/build-with-claude/context-editing> | §6.1A |
| Token counting | <https://platform.claude.com/docs/en/build-with-claude/token-counting> | §8.1, §8.4 |
| Tool use — overview | <https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview> | §4.3 |
| Define tools | <https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools> | §4.1, §4.2, §4.5 |
| Tool search tool | <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool> | §4.3, §4.6 |
| OpenAI — Prompt caching | <https://platform.openai.com/docs/guides/prompt-caching> | §3.3 |
| OpenCode — Providers | <https://opencode.ai/v2/docs/providers> | §3.3, §7.3 |
| OpenCode — Config | <https://opencode.ai/v2/docs/config> | §7.4, §7.6 |
| OpenCode — Warming | <https://opencode.ai/v2/docs/warming> | §7.1 |

### Blog Engineering của Anthropic `[BLOG1]`

| Trang | URL | Dùng cho |
| --- | --- | --- |
| Effective context engineering for AI agents (29/09/2025) | <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents> | §4.1, §4.2, §6.1B/D/E |
| Introducing advanced tool use (24/11/2025) | <https://www.anthropic.com/engineering/advanced-tool-use> | §4.3 (bảng 55k/85%/49%→74%) |
| Writing effective tools for agents (11/09/2025) | <https://www.anthropic.com/engineering/writing-tools-for-agents> | §6.1C (trần 25 000 token của Claude Code), §4.5 |

> `BLOG1` = first-party Anthropic. Khác hẳn blog bên thứ ba, vẫn là nguồn chính thức về khuyến nghị
> của hãng. **Không** có mục nào trong file này lấy từ blog của bên thứ ba.

### Benchmark `[BENCH]`

| Báo cáo | URL | Dùng cho |
| --- | --- | --- |
| Context Rot: How Increasing Input Tokens Impacts LLM Performance — Chroma Technical Report, 14/07/2025 | <https://research.trychroma.com/context-rot> | §6.2 |

### Spec đọc từ máy `[SPEC]` / `[MEAS]`

| Nguồn | Dùng cho |
| --- | --- |
| `GET http://127.0.0.1:4599/openapi.json` (276 535 ký tự) | §3.3, §7.2 |
| `GET http://127.0.0.1:4599/api/model` (10 model của provider `opencode`) | §2.1, §3.3 |
| `GET http://127.0.0.1:8787/health` | §2 |
| `bridge.log` (246 dòng, 62 turn `done`) | §2.3, §5.1 |
| `bridge.mjs` (đếm ký tự hằng số) | §2.1 |

### Nghiên cứu trước trong repo này (không nghiên cứu lại)

| File | Phần đã dùng |
| --- | --- |
| `RESEARCH-opencode-api.md` | §7 (`/generate` không có `cache_control`, không `supportsPromptCacheKey`, không có `usage`; system prompt không tắt được) |
| `RESEARCH-json-reliability.md` | §5.2 (Fission-GRPO, 2601.15625), §4.4 (BFCL format sensitivity), §5.3 (retry stateless), N4 |
| `RESEARCH-tool-call.md` | không trích — không cần |

---

## 13. Tóm lại

Ba kết luận đáng để nhớ, và một điều kiện:

1. **Prompt caching không phải câu trả lời.** 42k → ~1k không khả thi ở đây, vì **ba** rào độc lập
   (§3.4), và vì free tier giá `0` nên cache **không tiết kiệm tiền** — chỉ có thể tiết kiệm
   latency, còn quota thì **không đo được**. Đừng đầu tư.

2. **Cái đáng giảm nhất là thứ đã bị bỏ qua: tuổi của tool result.** Bridge có trần theo lượt
   nhưng **không có** khái niệm "kết quả nào đã cũ" — trong khi Anthropic coi tool result clearing
   là *"one of the safest lightest touch forms of compaction"*, và chính họ dùng nó ở ngưỡng
   **30 000 token**, trong khi bridge đặt trần ở **8 570 token/result** mà vẫn không có tuổi.

3. **Một phần ba token đang đi vào retry** (34.1%, đo được), và lượt retry đắt nhất đúng lúc
   turn đã lớn nhất. Không cắt `description` của tool để tiết kiệm token — Anthropic khuyến
   nghị **ngược lại**, và nói thẳng *"minimal does not necessarily mean short"*.

4. **Điều kiện:** chạy **P3** trước. Mọi con số ở P1/P2/P6 đều phụ thuộc kích thước khối tool
   schema, và con số đó chưa ai đo. Nó tốn **0 token** và **1 phút**.