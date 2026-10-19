# Vì sao model không dùng được tool call — và làm sao đo được nó rẻ

Nghiên cứu này **không** nghiên cứu lại `RESEARCH-json-reliability.md` hay
`RESEARCH-tool-call.md`. Nó nhắm một câu hỏi khác: khi bridge đã ép JSON envelope,
đã ép tool name, đã ép schema, đã thêm `tool_choice` cứng — **vì sao model vẫn
trả lời bằng lời thay vì gọi tool**, và làm sao đo điều đó với chi phí tối thiểu.

**Nguồn số liệu:** chỉ `webfetch` / `websearch`, đọc file local, và các endpoint
local **không gọi model** (`/v1/messages/count_tokens`, `/api/agent`,
`/openapi.json`, `https://opencode.ai/config.json`).
**Không** chạy `claude -p`, `probe-behaviour.mjs`, `start-bridge.ps1`, và không
gọi `/generate` hay `/prompt` với prompt thật.

**Mức chắc chắn**
- **CAUGHT UP** — đọc trực tiếp từ tài liệu / paper / API còn sống, hoặc đo được
  trên máy này hôm nay.
- **INFERRED** — suy ra từ nguồn thứ cấp (blog, lời giải thích của maintainer,
  trích dẫn trong paper khác). Có thể sai.
- **UNVERIFIED** — chưa ai đo được, kể cả tôi. Nêu rõ cách đo.

---

## 0. Tóm tắt điều đã biết trước khi bắt đầu

Từ `bridge.mjs` và log:

| Hiện tượng quan sát | Nơi ghi nhận |
|---|---|
| `ptok=75517, attempts=3, stop=end_turn, calls=[]`, model nói *"Continuing to read the rest… and kicking off research in parallel"* | `bridge.mjs` comment dòng 1824–1827 |
| Lượt trả **rỗng** (model thử native tool call, deployment bỏ) | `RETRY_HINTS[1]` dòng 1417 |
| `{"text":"Okay, I'll read the rest","tools":[]}` — đúng hình dạng, không làm gì | comment dòng 1849 |
| Protocol cố định ~1000 token mỗi lượt | **đo hôm nay**: `POST /v1/messages/count_tokens` với 0 tool, 1 message ngắn → `1000` |
| Bridge **không** có usage upstream | `bridge.mjs:1400-1408`, `README.md:596-598` |

Điểm cuối cùng quan trọng hơn người ta tưởng và sẽ quay lại ở §5:

> `runModel()` trả `usage.input = promptTokens`, tức `ceil(text.length / 2.8)` —
> **ước lượng của chính bridge trên transcript nó tự dựng**, không phải số token
> provider báo. `/generate` trả `{data:{text}}` và không kèm usage.
>
> → Mọi con số `tokens_spent` trong `bridge.log` là ước lượng cục bộ.
> → Con số "~7k token system prompt của OpenCode" và hằng số
> `FIXED_OVERHEAD_TOKENS = 12000` (`bridge.mjs:62`) là **giả định thủ công**,
> chưa từng được đo trên chính hệ thống này.

---

## 1. Prompt protocol cho tool calling khi không có tool channel

### 1.1 Anthropic **không** tài liệu hoá kỹ thuật này

> **Không tìm thấy tài liệu Anthropic nào hướng dẫn "buộc model trả tool call
> chỉ bằng prompt".** Anthropic có structured output native (mục 1.2) và có
> hướng dẫn *steer* ranh giới tool-calling bằng system prompt (mục 1.3), nhưng
> không có "text-based function calling" recipe.

Nguồn đã quét: `platform.claude.com/docs/en/agents-and-tools/tool-use/*`,
`platform.claude.com/docs/en/build-with-claude/*`. Kết quả tìm kiếm cho
`"prompt-based function calling"`, `"text-based function calling"`, `"JSON mode
via prompting"` chỉ ra tài liệu của bên thứ ba và benchmark, không ra tài liệu
Anthropic. **Mức: UNVERIFIED (không tìm thấy) — nhưng phạm vi đã quét rõ ở trên.**

### 1.2 Hướng ngược lại của Anthropic: đừng prompt, hãy dùng structured output

Anthropic đã có **Structured Outputs (GA)** với constrained decoding, tức
grammar-constrained JSON — tức là đúng thứ bridge đang mô phỏng bằng prompt:

- `output_config.format: {type: "json_schema", schema: {...}}` — JSON output
- `strict: true` trên tool definition — schema validation cho tool call
- `output_format` (tên cũ) **đã deprecated**, chuyển sang `output_config.format`

URL: https://platform.claude.com/docs/en/build-with-claude/structured-outputs

Trích nguyên văn, mục "Why use structured outputs":

> *"Without structured outputs, Claude can generate malformed JSON responses or
> invalid tool inputs that break your applications. **Even with careful
> prompting**, you may encounter: Parsing errors from invalid JSON syntax /
> Missing required fields / Inconsistent data types / Schema violations requiring
> error handling and retries"*

Đọc ngược lại: Anthropic đang nói **prompting không đáng tin**, và cung cấp đường
native thay thế. Bridge không dùng được đường đó (xem §4), nhưng điều này có hai
hệ quả:

1. **Đây không phải là "kỹ thuật được tài liệu hoá" mà là đường vòng.** Bất kỳ
   hướng dẫn nào trên mạng về "prompt-based tool calling" đều không có trọng
   lượng tương đương tài liệu chính thức.
2. **Chi phí của đường vòng là có thật**, và được đo (mục §3.1).

Danh sách model hỗ trợ được liệt kê trong trang: `claude-fable-5-1`,
`claude-opus-5-5`, `claude-sonnet-5`, `claude-haiku-5-5`, …
`space-bunny-free` (model của bridge) **không** nằm trong danh sách này — dù
nó có thể là gateway OpenAI-compatible phía sau, không phải Claude trực tiếp.

**Mức: CAUGHT UP.**

### 1.3 Thứ Anthropic *có* tài liệu hoá: thang lái tool-trigger bằng system prompt

Đây là trích dẫn sát nhất với câu hỏi của dự án:

> *"This boundary is steerable through your system prompt. If Claude isn't
> calling tools when you expect, a light instruction such as **`"Use the tools
> to investigate before responding."`** increases tool use. A stronger form such
> as **`"Always call a tool first before responding."`** pushes further.
> Conversely, **`"Use your judgment about whether to call a tool or respond
> directly."`** keeps triggering behavior conservative.
> **To require a tool call rather than rely on prompting, set `tool_choice`.**"*
>
> — https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview#when-claude-uses-tools

Ba điều suy ra được, tất cả đều CAUGHT UP vì là trích dẫn nguyên văn:

1. **Có một thang độ mạnh, và nó là hữu hạn.** "Light" → "stronger" → hết.
   Bridge hiện đang ở mức "stronger" (nhiều lần nhấn mạnh) mà chưa hiệu quả —
   nên bước tiếp theo trên thang này **không phải là thêm câu nữa**, mà là
   chuyển sang kênh khác.
2. **"Use your judgment about whether to call a tool or respond directly"** được
   nêu là câu **làm giảm** tool use. `opencode serve` inject một prompt agent
   đúng loại đó (mô tả bộ tool, nói model tự quyết). Bridge đang phải đấu với
   nó (xem §4).
3. **`tool_choice` là cơ chế được khuyến nghị thay prompt.** Bridge đã map nó
   (`toolChoiceLines`, dòng 848) — và đây là **đường duy nhất** trong toàn bộ
   thiết kế hiện tại có cơ sở tài liệu.

Trang cũng nói: *"When you use `tools`, the API also automatically includes a
special system prompt for the model that enables tool use"*, kèm bảng token
(system prompt tool-use, không tính phần schema):
Claude Sonnet 5 = 354 token (`auto`/`none`), 474 (`any`/`tool`);
Claude Haiku 4.5 = 496 / 588; Claude Sonnet 4.6 = 497 / 589.

**Điểm quan trọng cho bridge:** vì bridge **không** gửi `tools` trong request
(nó đưa schema vào prompt), nên **system prompt tool-use 286–675 token đó không
tồn tại** ở phía model. Model không bao giờ nhận chỉ dẫn "bạn là một agent dùng
tool" từ chính tầng API. Nó chỉ có prompt của OpenCode + prompt của bridge.
Đây là một ưu việc bù cho việc thiếu kênh tool, và có thể đo được (§5, case E2
vs E6).

### 1.4 Bằng chứng rằng prompting đôi khi **thắng** native function calling

Gorilla (BFCL) discussion #606, 26–29/08/2024:
https://github.com/ShishirPatil/gorilla/discussions/606

Người hỏi báo cáo trên leaderboard: `GPT-4-1106-preview (Prompt)` = **85.65**
còn `GPT-4-1106-preview (FC)` = **79.65**. Maintainer ShishirPatil trả lời:

> *"Different models have very limited capability when it comes to
> function-calling. For example, some models might not even support multiple or
> parallel function calling. On the other hand, with Prompting they can support
> this based on the instructions. So, it's quite likely that the FC models
> perform quite well when it comes to FC on simple tasks, but might not have
> support for more advanced features where prompting models score non-0. Net,
> for some models, prompting is better in expectation!"*

**Mức: INFERRED.** Đây là ý kiến maintainer dựa trên đọc bảng phân rã của một
leaderboard, không phải kết quả nghiên cứu có kiểm soát; chỉ một model, một năm
tuổi, và "prompting" ở đây không có kiểm soát tương tác prompt như bridge đang
làm. **Dùng để biện minh cho việc thử đường vòng — không dùng làm bằng chứng rằng
đường vòng hiệu quả.**

### 1.5 Một hướng thay thế đáng cân nhắc: programmatic tool calling

arXiv 2608.06370, "The Bitter Lesson of Tool Calling" (PwC, 06/08/2026):
https://arxiv.org/html/2608.06370v1

Thay vì bắt model phát JSON, biến tool thành **typed Python stub** và bắt model
viết script — trên BFCL v4 (309 entry, 14 model), **11/14 model bằng hoặc hơn**
JSON tool calling; nhóm GPT-5.6 mới nhất hơn tới **+10.6 điểm tuyệt đối**.

**Mức: CAUGHT UP** (đọc paper) nhưng **đáng nghi về mức độ tin cậy**: preprint,
chưa qua phản biện, phương pháp đo bằng echo-stub nên chỉ đo được độ chính xác
serialise argument chứ không đo được tool-use end-to-end — chính tác giả cũng nói
vậy ở mục Limitations. Ba model OpenAI cũ tụt 19.7–26.9 điểm do lỗi `\n`.

**Vì sao đáng xét cho bridge:** nó loại bỏ đúng nỗi đang đau — *serialise JSON
đúng hình dạng*. Model viết code thì không có "tool call native bị deployment nuốt",
vì không có khái niệm tool call native nào trong output. Chi phí: bridge phải
thay toàn bộ `extractJson`/`normalizeEnvelope` bằng một sandbox thực thi script,
tức là **mở lại đường thực thi mà thiết kế hiện tại cố ý đóng**. Đánh giá ở §9.

---

## 2. Điều khiến model không gọi tool dù prompt yêu cầu

Đây là câu quan trọng nhất. Bằng chứng công bố được, theo mức độ sát vấn đề.

### 2.1 Ràng buộc chồng lên nhau làm tỉ lệ tuân thủ **tụt đầu khi tăng** — có đo

**Instruction Stacking Collapse** (arXiv 2608.02639, 31/07/2026):
https://arxiv.org/html/2608.02639v1

24 ràng buộc có verifier tất định, xếp chồng ngẫu nhiên 1–20 ràng buộc/prompt,
3 model (Claude Sonnet 4.6, GPT-5-mini, Gemini 2.5 Flash), task advice chính +
GSM8K + HumanEval.

| Model | stack=1 | stack=5 | stack=16 | stack=20 |
|---|---|---|---|---|
| Sonnet 4.6 | .964 | .827 | .621 | **.604** |
| GPT-5-mini | .964 | .845 | .259 | **.200** |
| Gemini 2.5 Flash | .959 | .823 | .535 | **.433** |

Kết luận rút ra đúng cho bridge:

- Suy giảm **phi tuyến**, không tuyến tính. Ở Sonnet 4.6, đi từ 1 lên 5 ràng
  buộc mất 14 điểm; từ 16 lên 20 chỉ mất 1.7 điểm. Nghĩa là **rất dễ rơi vào
  vùng "đã gãy" ở mức thấp**, khó hồi phục bằng việc thêm quyền lợi.
- **"valid JSON" là nút xung đột trung tâm.** Nó *không thể đồng thời* thỏa với
  9 ràng buộc khác (mọi ràng buộc markdown, "Summary:" dạng dòng trần, v.v.).
  Trong một ví dụ, 8 ràng buộc chồng lên nhau, GPT-5-mini thỏa `valid JSON` và
  **âm thầm làm hỏng 4 ràng buộc khác** — không có lỗi nào được báo.
- ~**12%** các cặp ràng buộc *thỏa được về lý thuyết* vẫn hỏng nhiều hơn dự
  đoán từ tích phần (95% CI [4.6, 11.6]).
- Thứ tự xung đột **tái lập được** qua 3 model và 2 task
  (Spearman ρ = +0.23 … +0.44).

**Hệ quả trực tiếp cho bridge:** `RESPONSE_PROTOCOL` (dòng 1065) đang chồng
khoảng 15 ràng buộc lên một prompt vốn đã có phần "đọc file" của Claude Code,
`AGENTS.md`, và ~7k token prompt của OpenCode. Theo đường cong này, phần lớn thiệt
hại xảy ra ở **ràng buộc thứ 5 đến thứ 8**. Cắt bớt ràng buộc có giá trị hơn
thêm ràng buộc.

> **Cảnh báo hợp lệ:** `space-bunny-free` là model free tier, khả năng thấp hơn
> `GPT-5-mini` nhiều. Nếu chỉ dùng một điểm của bảng trên, điểm đó là: ở 20 ràng
> buộc, model yếu còn **20%** — bridge đang ở vùng mà tỉ lệ tuân thủ rơi dốc.

### 2.2 Model yếu **bỏ rơi** ràng buộc chứ không sửa sai

**IFScale** (arXiv 2507.11538, 15/07/2025):
https://arxiv.org/html/2507.11538v1

500 ràng buộc "include the exact word X", 20 model, 7 nhà cung cấp.
Ba kiểu suy giảm: **threshold decay** (model reasoning), **linear decay**,
**exponential decay** (model nhỏ — ví dụ `claude-3.5-haiku`: 98.0% ở 10 → 78.0% ở
50 → 43.4% ở 100 → **8.5% ở 500**).

Phần đáng chú ý nhất cho bridge nằm ở §4.8:

> *"Models overwhelmingly err toward **omission** errors as instruction density
> increases."* — `llama-4-scout` đạt tỉ lệ omission:modification = **34.88** ở
> 500 ràng buộc. `claude-3.5-haiku` và `llama-4-maverick` giữ tỉ lệ trên 20–30.

**Đây chính xác là triệu chứng của bridge:** model **không** làm sai cách gọi
tool, mà **không gọi tool**. Nó bỏ qua yêu cầu thay vì thực thi sai. Suy giảm âm
thầm, không có lỗi nào được ném.

Ngoài ra, §4.6 của IFScale đo **primacy effect** = (lỗi ở 1/3 cuối) / (lỗi ở
1/3 đầu), đỉnh quanh **150–200 ràng buộc**, rồi hội tụ về 1.0–1.5 khi quá tải
hoàn toàn.

### 2.3 Bối cảnh nhiễu (decoy schemas) làm giảm độ chính xác tool calling

"The Bitter Lesson of Tool Calling", §4.4 — ablation "context rot": thêm schema
giả từ miền không liên quan cho tổng 128 schema so với chỉ schema liên quan.
Trung bình 14 model: **JSON tool calling −2.3 điểm tuyệt đối**; biến thể
"filesystem-discovery" −32.0.

Cần đọc đúng nghĩa: −2.3 là *trung bnh nhỏ*, và phạm vi cá nhân là **−6.5 đến
+35.5**. Tức là đối với một số model, 7k token prompt OpenCode quảng bá
`shell`/`read`/`write`/`edit`/`subagent` **không chỉ vô hại mà còn hại** — và
chính đó là giả thuyết cần đo ở §5.

**Mức: INFERRED** cho hệ quả áp dụng lên bridge (paper đo trên BFCL, không phải
trên `space-bunny-free`).

### 2.4 Model có thể **bỏ hẳn** tool call ở ngưỡng fan-out

Cùng paper, §4.3/§5.2: JSON tool calling **bỏ call** khi số call song song vượt
ngưỡng riêng của model. Claude Sonnet 5: đếm đủ 100% ở N≤70, **75% ở N=72, 0%
ở N=100**. Cơ chế được mô tả: model phải phát một khối tool-call song song trong
một response, và ở fan-out cao bắt đầu bỏ sót.

**Liên hệ:** bridge chỉ cần 1 call thì chưa chạm ngưỡng, nhưng đây là bằng chứng
rằng **"phát nhiều call trong một hành động" là điểm yếu có cấu trúc**, không phải
lỗi ngẫu nhiên. Đừng kỳ vọng chạy song song nhiều tool một lúc.

### 2.5 Trường hợp riêng: system prompt xung đột

Tôi **không tìm thấy nghiên cứu định lượng nào** về "hai system prompt mâu thuẫn
làm giảm tool calling". Nguồn gần nhất là `Instruction Stacking Collapse` (§2.1):
"valid JSON" là nút xung đột trung tâm, và nó **tái lập được qua model**. Suy ra
`INFERRED`: prompt OpenCode (quảng bá tool thật của nó, dạy `replaceAll`) cộng
prompt bridge (dạy `replace_all`, cấm native call) là một cặp ràng buộc mâu
thuẫn — đúng dạng cặp mà paper đó đo là hỏng.

`IFScale` §4.6 (primacy, ưu tiên ràng buộc đứng trước) cho thêm một góc: **quy
tắc đứng trước thắng**. Prompt OpenCode nằm **trước** prompt bridge trong thứ
tự hệ thống (OpenCode prepend). Chi tiết này ủng hộ việc đặt lệnh quan trọng
nhất của bridge **sát đầu ra** — điều mà `buildTranscript` đã làm bằng `closer`.

**Mức: UNVERIFIED.** Không có nghiên cứu nào đo trực tiếp. Đây là giả thuyết để
kiểm chứng bằng §5.

---

## 3. Ràng buộc định dạng trong prompt

### 3.1 Đưa schema vào prompt **làm tệ hơn** — và tăng phương sai rất nhiều

"Let Me Speak Freely? A Study on the Impact of Format Restrictions on Performance
of Large Language Models" (arXiv 2408.02442, 05/08/2024):
https://arxiv.org/html/2408.02442v1

Ba mức ràng buộc: **JSON-mode** (constrained decoding) > **FRI** (format-restricting
instruction, có schema trong prompt) > **NL-to-Format** (trả lời tự do rồi mới
chuyển đổi).

Kết quả trên GSM8K (exact match):

| Model | JSON, không schema trong prompt | JSON, **có** schema trong prompt |
|---|---|---|
| Claude-3-Haiku | 86.99 (sd 0.2) | **23.44 (sd 22.9)** |
| GPT-3.5-turbo | 74.70 (1.1) | **49.25 (12.0)** |
| LLaMA-3-8B | 64.67 (2.23) | **48.90 (6.7)** |

Ba điều rút ra, tất cả **CAUGHT UP**:

1. **Chỉ cần thêm schema vào prompt là điểm chính xác của Claude-3-Haiku tụt từ
   87 xuống 23.** Đây không phải hiệu ứng nhỏ. Bridge in **toàn bộ** schema
   23 tool của Claude Code vào prompt (`buildTranscript`, dòng 922).
2. **Phương sai bùng nổ**: sd 0.2 → 22.9. Nghĩa là cùng một prompt, cùng nhiệm vụ,
   kết quả có thể là 23 hoặc 87 tuỳ lần chạy. Với `MAX_ATTEMPTS = 3`, đó là hệ
   thống **ném tiền cho lottery ticket**.
3. **"Looser" thắng**: chỉ yêu cầu *"Reply your answer in JSON format"*, không kèm
   schema, **tăng điểm trung bình và giảm độ lệch chuẩn** trên Claude-3-Haiku,
   GPT-3.5-turbo, LLaMA-3-8B.

Một chi tiết cơ chế đáng chú ý (§4.1): 100% câu trả lời JSON-mode của GPT-3.5
đặt khoá `"answer"` **trước** khoá `"reason"`, biến chain-of-thought thành trả lời
thẳng. **Thứ tự khoá trong schema điều khiển thứ tự suy luận.** Bridge chưa dùng
điều này (§9, đề xuất 2).

Và một cảnh báo quan trọng (§5.3): **lỗi parse không phải nguyên nhân chính**.
LLaMA-3-8B ở Last Letter có tỉ lệ lỗi parse JSON chỉ **0.148%** nhưng vẫn hụt
**38.15 điểm**. Hiệu năng giảm **không** phải vì JSON hỏng, mà vì ràng buộc đổi cách
model suy luận. Nghĩa là: **cứ thêm `extractJson` giỏi hơn là chữa bệnh ngoài da.**

### 3.2 Vị trí trong prompt — bằng chứng có, nhưng **ngược** với trực giác

**Order Matters** (arXiv 2502.17204v2, 03/03/2025):
https://arxiv.org/html/2502.17204v2

Phát hiện chính: *"LLMs exhibit **dramatic performance fluctuation** when
disturbing the order of the incorporated constraints."* Và:

> *"LLMs are more performant when presented with the constraints in a
> **hard-to-easy** order."*

Kết quả cụ thể (LLaMA3-8B-Instruct, 7 ràng buộc): chênh lệch ~**7%** giữa hai thứ
tự cực đoan; Qwen2.5-7B ~5%. Ở **multi-round inference** (thứ tự ràng buộc được
đưa vào dần qua các lượt) chênh lệch lớn hơn nhiều: LLaMA3-8B/70B ~**25%** khi
chuyển từ "easy-to-hard" sang "hard-to-easy".

Giải thích bằng gradient attribution: thứ tự "hard-to-easy" khiến model **dành
tổng trọng số chú ý cao nhất cho phần ràng buộc**; hiệu suất trên từng loại ràng
buộc tương quan chặt với trọng số attention của nó.

**Ba điều cần nói thẳng:**

- **Mức: CAUGHT UP** cho phát hiện.
- **Không có model Claude frontier nào trong nghiên cứu này.** Model là LLaMA3-8B/70B,
  LLaMA2-13B, Mistral-7B-v0.3, Qwen2.5-7B, GPT-4o-mini. Chuyển sang
  `space-bunny-free` là **ngoại suy, không phải đo**.
- **Kết luận này ngược với trực giác "đặt ở cuối".** Nó nói: thứ tự phải theo
  *độ khó*, không theo *vị trí*. Không có cơ sở để nói "đặt schema ở cuối tốt
  hơn đặt ở đầu" một cách phổ quát.

Về "lost in the middle" (Liu et al., *Lost in the Middle: How Language Models Use
Long Contexts*, TACL 2024, arXiv 2307.03172) — hiệu suất cao nhất khi thông tin
liên quan ở **đầu** hoặc **cuối**, thấp nhất ở **giữa**.
**Mức: INFERRED** — tôi không fetch trực tiếp bài này; chi tiết thư mục lấy từ
danh mục tham khảo của `Order Matters` (đã đọc đầy đủ). Đây là kết quả cho
**truy xuất trong ngữ cảnh dài**, không phải cho tuân thủ ràng buộc — không
được suy ra trực tiếp.

`IFScale` §4.6 đo lại điều này theo hướng ngược: ở mật độ cao, **ràng buộc đứng
trước được thỏa nhiều hơn**; nhưng đỉnh của hiệu ứng này nằm ở 150–200 ràng buộc,
xa hơn nhiều so với ~15 ràng buộc của bridge.

### 3.3 Few-shot

Không tìm được một nghiên cứu *định lượng, peer-reviewed* nào đo riêng "thêm N ví
dụ mẫu JSON vào prompt tăng tỉ lệ JSON hợp lệ" trong bối cảnh không có tool
channel. Nguồn gần nhất:

- "Reliable Constrained Generation with LLMs" (Mondal et al., BigData 2025) —
  https://exascale.info/assets/pdf/mondal2025bigdata.pdf — biến thiên số ví dụ
  **tới 4 shot**, so sánh với zero-shot. **Mức: INFERRED**, tôi chỉ đọc được đoạn
  trích trong kết quả tìm kiếm, chưa đọc toàn bộ paper.
- "Let Me Speak Freely?" (đã đọc) cho thấy độ nhạy cảm với **thứ tự câu chữ** trong
  chính phần format description: 9 tổ hợp prompt → biến thiên tới **56%** trên
  NI-Task 280 (dẫn Sclar et al., 2023).

**Kết luận thành thật: về few-shot, tôi không có số liệu đáng tin cho tình huống
này.** Đề xuất ở §9 vì vậy được đánh dấu là **thử nghiệm có phép đo** (§5), không
phải khuyến nghị dựa trên bằng chứng.

### 3.4 Self-consistency

Wang et al., *Self-Consistency Improves Chain of Thought Reasoning in Language
Models*, ICLR 2023, arXiv 2203.11171 — https://arxiv.org/abs/2203.11171

Self-consistency (lấy mẫu nhiều đường suy luận, chọn đáp án đa số) cải thiện
GSM8K **+17.9 điểm**, SVAMP +11.0, AQuA +12.2, StrategyQA +6.4, ARC-challenge +3.9.
**Mức: CAUGHT UP.**

**Nhưng nó không giải quyết vấn đề của bridge, và có thể làm tệ.** Self-consistency
là kỹ thuật **N lần gọi model mỗi lượt** — chính xác thứ mà ngân sách free tier
không chịu được. Hơn nữa, nếu lỗi của bridge là *tất định theo hình thức* (model
luôn phát envelope rỗng vì bị prompt OpenCode dẫn), thì 10 lần lấy mẫu sẽ ra 10
kết quả giống hệt nhau. Self-consistency chỉ ăn khi lỗi là **ngẫu nhiên**.

Đây là lý do phép đo ở §5 phải chạy **lặp lại nhiều lần** và báo cáo `k/n`, chứ
không phải pass/fail một lần.

### 3.5 "Output token budget hint" trong prompt

**Không tìm thấy tài liệu Anthropic nào khuyến nghị viết "giữ câu trả lời dưới
N token" trong prompt** như một kỹ thuật tăng độ hợp lệ JSON.
**Mức: UNVERIFIED (không tìm thấy).**

Có hai dữ kiện *gián tiếp*, đều ngược chiều:

- `IFScale` §4.9: `o3` và `o4-mini` suy giảm mạnh về coherence ở mật độ cao, và
  tác giả quy cho *"its reluctant to generate a large amount of output tokens"* —
  ở 500 ràng buộc `o3` chỉ xuất **1500 token**.
- `Instruction Stacking Collapse` Appendix D: ràng buộc **length** và **format**
  là nhóm sụt điểm nhanh nhất khi chồng lên nhau.

Điều này gợi ý rằng bỏ bớt ràng buộc độ dài khỏi protocol có thể tốt hơn là thêm
một. `RESPONSE_PROTOCOL` hiện có một ràng buộc như vậy:
*"Keep \"text\" brief when calling tools; use \"\" if there is nothing to say."*

---

## 4. Giảm prompt xung đột — có cách nào vô hiệu hoá prompt của OpenCode không?

### 4.1 `/generate` không nhận tham số nào để làm việc đó

Đo hôm nay trên `http://127.0.0.1:4599/openapi.json`:

```json
"/api/session/{sessionID}/generate": {
  "operationId": "session.generate",
  "description": "Generate transient text from the current session context
                  without mutating session history.",
  "requestBody": { "schema": {
    "type": "object",
    "properties": { "prompt": { "type": "string" } },
    "required": ["prompt"],
    "additionalProperties": false } }
}
```

**CAUGHT UP.** Không `system`, không `tools`, không `tool_choice`, không `agent`.
Không có đường vòng nào qua payload.

### 4.2 `agents.<id>.system` **tồn tại và được nạp** — và đây là đường chưa thử đúng

Đây là phát hiện mới của phiên này.

**(a) Schema config sống** — https://opencode.ai/config.json, `$defs/Config.AgentEncoded`:
```json
{ "system": { "type": "string" } }
```
cùng với `model`, `request{headers,body}`, `description`, `mode`, `hidden`,
`color`, `steps`, `disabled`, `permissions`. **CAUGHT UP.**

**(b) Agent trả về từ API server có trường `system`.** Đo hôm nay, `GET /api/agent`
(127.0.0.1:4599, Basic auth):

| agent | `system` |
|---|---|
| `build` | **không có trường** |
| `general` | **không có trường** |
| `explore` | **có**, ~700 ký tự, mô tả vai trò "file search specialist" |

**Suy ra (CAUGHT UP quan sát, INFERRED suy luận):** `system` là *system prompt
tuỳ biến riêng của agent*. `explore` có nó vì OpenCode định nghĩa cho nó.
`build`/`general` không có nghĩa là chúng **rơi về base prompt của OpenCode** —
chính base prompt quảng bá `shell`/`read`/`write`/`edit`/`subagent`.

**Cơ chế đề xuất (giả thuyết, cần kiểm chứng bằng 1 lần gọi):** đặt
`agents.ccbridge.system` = protocol của bridge, và gán agent đó cho session qua
`POST /api/session/{id}/agent`. Nếu `/generate` resolve agent theo session, phần
tuỳ biến của bridge sẽ **thay** base prompt thay vì đứng sau nó.

**Rủi ro:**
- **Không biết `/generate` có resolve agent hay không.** README (dòng 593–595)
  ghi `agent: "ccbridge"` **set được** trên session nhưng **không** gỡ được prompt —
  đo bằng cách *hỏi model liệt kê tool của nó*. Đó là **self-report của LLM với
  câu hỏi mở**, không phải đo trực tiếp, và chỉ một lần thử. Bằng chứng yếu hơn
  vẻ ngoài.
- Nếu base prompt vẫn được **tiền tố** và prompt bridge thành **hậu tố**, ta mất
  ~7k token mà không đổi được gì — tệ hơn hiện tại.
- Nguy cơ xung đột mới: hai mô tả tool cùng tồn tại.
- `permissions: deny` trên agent → `403 FreeTierError` (đã đo, `opencode-config/opencode.json`).
  Agent tuỳ biến **không được** mang deny rule.

**Mức: UNVERIFIED.** Cách kiểm chứng rẻ nhất nằm ở §5.6 (case E9).

### 4.3 Những khoá config đã loại trừ — và cái giá của việc loại trừ

Đọc `https://opencode.ai/config.json` bản sống, `additionalProperties: false`
ở cấp gốc:

| Khoá | Trạng thái | Ghi chú |
|---|---|---|
| `agents` | ✔ có | `Config.AgentEncoded` có `system` |
| `instructions` | ✔ có | *"Additional paths or URLs supplying ambient instructions"* — **thêm**, không bớt |
| `permissions` | ✔ có | Nhưng `deny` → `403 FreeTierError` (đo trước đây) |
| `policies` (`tool.use`) | ✔ có | Chặn **sau** rules; không xoá khỏi catalog |
| `experimental.primary_tools` | ✔ có, **deprecated** | *"Tools that should only be available to primary agents"* |
| `agent.<id>.tools` | **không có trong `Config.AgentEncoded`** | Nằm ở `AgentConfig` cũ (deprecated) |
| `tools` (top-level) | deprecated V1 | Đưa vào → `403 FreeTierError` (đo) |
| `mode` | deprecated | |
| `agent` (số ít) | deprecated V1 | **Đây là nguyên nhân gốc của test canary cũ sai** |

**CAUGHT UP** cho toàn bộ bảng (đọc schema sống + ghi chú trong
`opencode-config/opencode.json` và `RESEARCH-opencode-api.md` §6.4).

**Kết luận: không có khoá nào "tắt system prompt".** Chỉ có "thay system prompt
tuỳ biến của agent" (`agents.<id>.system`, §4.2) — chưa kiểm chứng cho `/generate`.

### 4.4 Đường JSON mode thật sự tồn tại — qua provider config

`Config.ProviderEncoded` có `body: {type: "object"}`; `Config.ModelEncoded` có
`body` và `variants[].body`. Đây là chỗ để **bơm `response_format` vào request
upstream**. Trùng với `RESEARCH-opencode-api.md` §8.1.5. **CAUGHT UP** cho schema.

Nhưng provider là `opencode.ai/inference` kiểu **openai-compatible** (theo
`RESEARCH-opencode-api.md` §7), nên nó sẽ cần `response_format` kiểu OpenAI, không
phải `output_config.format` kiểu Anthropic. Cổng có tôn trọng không:
**UNVERIFIED.** Cách kiểm chứng: 1 lần gọi, xem reply còn là prose hay không.

### 4.5 Đường thoát thật sự: chuyển sang `/prompt`

`RESEARCH-opencode-api.md` §8.2 đã kết luận và tôi không có gì để bổ sung. Tóm
tắt: `/prompt` là route **duy nhất** chạy agent loop và tool thật; chặn được bằng
`permissions` đúng cách; đổi lại là mất kênh control và phải tự quản lịch sử.

---

## 5. Đo lại chất lượng — bộ phép đo rẻ và dùng lại được

Đây là phần quan trọng nhất. Thiết kế dựa trên một phát hiện ở §0:
**bridge không có usage upstream**, nên bất kỳ phép đo nào dựa vào log hiện có đều
đo sai. Phép đo phải chạy ở **tầng HTTP của bridge** và tự đếm.

### 5.1 Nguyên tắc

1. **Đo cái Claude Code thấy, không đo cái bridge nghĩ.** Mỗi lượt đo phải kiểm
   **cả** response HTTP cuối cùng **và** dòng `done` trong `bridge.log`.
2. **`attempts` là một phần của kết quả.** Turn cần 2–3 lần gọi để thành công
   vẫn là **hỏng** trên free tier: 3 lần × 2000 token = 6000 token cho một việc
   lẽ ra tốn 2000.
3. **Đo tỉ lệ `k/n`, không đo pass/fail.** Lỗi có tính ngẫu nhiên (§3.4).
4. **Hai tầng: replay (0 token) và live (rẻ).** Tầng replay tái dùng mãi mãi;
   tầng live xác nhận điều replay không bắt được.
5. **Không dùng Claude Code làm client.** Claude Code gửi system prompt hàng chương
   token và 23 tool. Harness tự dựng body với system prompt 75 ký tự. Đây là
   **phép giảm chi phí lớn nhất** — và là đánh đổi phải nói rõ (§5.5).

### 5.2 Chi phí thật — đo hôm nay, 0 token

Đo bằng `POST http://127.0.0.1:8787/v1/messages/count_tokens` (endpoint này chỉ
gọi `buildTranscript()`, **không** gọi model — `bridge.mjs:2351-2354`):

| Case | Input token (đo được) |
|---|---|
| E1 — 0 tool, 1 message ngắn | **1000** |
| E2 — 0 tool + `tool_choice:{type:"any"}` | **1050** |
| E3 — 3 tool (mô tả ngắn) + system 75 ký tự | **1222** |
| E4 — mid-loop, 1 tool_result 2000 ký tự, 3 tool | **1993** |
| E4 + `tool_choice:{type:"any"}` | **2043** |
| E4 + `<system-reminder>` đi kèm | **2009** |
| E4 + 10 tool (mô tả dài) | **3851** |
| E6 — 0 tool, `tool_choice` không có | **1000** |

Sàn cố định là **1000 token** = toàn bộ `# AVAILABLE TOOLS` + `RESPONSE_PROTOCOL` +
`FINAL:` closer, không cần một byte hội thoại nào.

**Ngân sách:**

| Hạng mục | Token |
|---|---|
| 7 case × 1 lần, input | ≈ **12 200** |
| Output (`max_tokens=300`, thực tế ~80/lượt) | ≤ 2 100 |
| **Một lượt đầy đủ (7 case, 1 repeat)** | **≈ 14 300** |
| **Ba repeat (đủ để thấy 0/3 vs 3/3)** | **≈ 43 000** |
| E9 (opt-in, xem §5.6) | + ~2 000 |
| E8 replica đầy đủ (opt-in, ~20k ký tự tool_result + 10 tool) | + **~11 000** |

### 5.3 Danh sách case — đủ cụ thể để viết thành file

Mỗi case là một entry JSON. `tools` dùng **tên Claude Code thật** và **key Claude
Code thật** (`file_path`, `old_string`/`new_string`), không dùng `filePath` — để
harness đo đúng thứ Claude Code gửi, đồng thời tránh việc OpenCode dạy sai key.

<details><summary><b>E1 — <code>text-only-baseline</code> · 0 tool · 1 lượt</b></summary>

```json
{
  "id": "E1",
  "name": "text-only-baseline",
  "why": "Control. Protocol phải sinh envelope text hợp lệ khi không có tool.",
  "body": {
    "model": "claude-sonnet-4-6",
    "max_tokens": 300,
    "system": "You are Claude Code, Anthropic's official CLI for Claude.",
    "messages": [{ "role": "user", "content": "Reply with the single word: ready" }]
  },
  "expect": {
    "attempts": 1,
    "stop_reason": "end_turn",
    "min_content_blocks": 1,
    "no_tool_use": true
  },
  "tokens_in": 1027
}
```
**Fail =** `attempts > 1` (protocol hỏng, mọi case khác vô nghĩa), hoặc có `tool_use`
(không có tool nào được cấp).
</details>

<details><summary><b>E2 — <code>tool-choice-any</code> · 3 tool · 1 lượt</b></summary>

```json
{
  "id": "E2",
  "name": "tool-choice-any",
  "why": "Kênh cứng duy nhất có tài liệu (§1.3). Phải ra tool_use ở attempt 1.",
  "body": {
    "model": "claude-sonnet-4-6",
    "max_tokens": 300,
    "system": "You are Claude Code, Anthropic's official CLI for Claude.",
    "tool_choice": { "type": "any" },
    "tools": [
      { "name": "Read",
        "description": "Read a file from the local filesystem.",
        "input_schema": { "type": "object",
          "properties": { "file_path": { "type": "string", "description": "Absolute path" } },
          "required": ["file_path"], "additionalProperties": false } },
      { "name": "Bash",
        "description": "Run a shell command.",
        "input_schema": { "type": "object",
          "properties": { "command": { "type": "string" } },
          "required": ["command"], "additionalProperties": false } },
      { "name": "Grep",
        "description": "Search file contents with a regular expression.",
        "input_schema": { "type": "object",
          "properties": { "pattern": { "type": "string" },
                          "path": { "type": "string" } },
          "required": ["pattern"], "additionalProperties": false } }
    ],
    "messages": [{ "role": "user",
      "content": "Read the file bridge.mjs and tell me which function parses the JSON envelope." }]
  },
  "expect": {
    "attempts": 1,
    "stop_reason": "tool_use",
    "tool_names_any": ["Read", "Bash"],
    "schema_valid": true
  },
  "tokens_in": 2043
}
```
**Fail =** không có `tool_use`; hoặc `calls=[]`; hoặc `stop_reason != "tool_use"`;
hoặc `attempts > 1` (chấp nhận được nhưng phải ghi vào báo cáo).
</details>

<details><summary><b>E3 — <code>tool-choice-named</code> · 1 lượt</b></summary>

Thân giống E2 nhưng `tool_choice: {"type":"tool","name":"Read"}`, và user message
là một yêu cầu **không liên quan gì đến đọc file**:
`"What is 17 * 23? Answer with the number only."`

**Cơ chế đang được đo:** `tool_choice:{type:"tool"}` có bị model chấp hành không,
hay nó trả lời đúng câu hỏi và bỏ qua. `bridge.mjs:1873-1875` chỉ chấp nhận đúng
tên bị ép — đây là test cho đúng nhánh đó.
**Fail =** tool khác tên `Read`, hoặc không có tool_use. **tokens_in ≈ 2000.**
</details>

<details><summary><b>E4 — <code>mid-loop-continue</code> · <b>case quan trọng nhất</b> · 1 lượt</b></summary>

```json
{
  "id": "E4",
  "name": "mid-loop-continue",
  "why": "Tái hiện đúng lỗi trong bridge.log: midToolLoop=true, model kết thúc bằng lời.",
  "body": {
    "model": "claude-sonnet-4-6",
    "max_tokens": 300,
    "system": "You are Claude Code, Anthropic's official CLI for Claude.",
    "tools": [ /* cùng 3 tool như E2 */ ],
    "messages": [
      { "role": "user", "content": "Read bridge.mjs and tell me how extractJson works." },
      { "role": "assistant", "content": [
        { "type": "text", "text": "I'll read the file." },
        { "type": "tool_use", "id": "toolu_harness_01", "name": "Read",
          "input": { "file_path": "bridge.mjs" } } ] },
      { "role": "user", "content": [
        { "type": "tool_result", "tool_use_id": "toolu_harness_01",
          "content": "…2 800 ký tự trích bridge.mjs, phần buildTranscript…\n" },
        { "type": "text", "text": "<system-reminder>Continue.</system-reminder>" } ] }
    ]
  },
  "expect": { "narration": false },
  "tokens_in": 2009
}
```

**Pass/fail định nghĩa rõ (đây là case định nghĩa metric chính):**

| Kết quả | Phân loại |
|---|---|
| HTTP 200, `stop_reason:"tool_use"`, ≥1 block `tool_use` tên hợp lệ | **PASS** |
| HTTP 200, `stop_reason:"end_turn"`, `text` **không** khớp `NARRATION_ACTION` | **PASS** (đây là một câu trả lời hoàn chỉnh hợp lệ) |
| HTTP 200, `stop_reason:"end_turn"`, `text` **khớp** `NARRATION_ACTION` | **FAIL — narration** |
| HTTP 200, `attempts>1` | **FAIL — retry**, ghi riêng (không tính vào narration) |
| HTTP 4xx/5xx | **FAIL — error**, ghi `status` |
| HTTP 200 nhưng **reply rỗng** | **FAIL — native-call-drop**, đếm riêng |

**Vì sao tách "narration" khỏi "retry" thành hai số:** chúng là hai lỗi khác
nguyên nhân với hai cách chữa khác nhau (§9). Gộp chung sẽ che mất cái nào đang
tăng.

**Lưu ý về `NARRATION_ACTION`:** regex nằm trong `bridge.mjs:1462-1475`, **không**
export ra ngoài. Harness phải import từ `bridge.mjs` (đã export `looksLikeNarration`,
dòng 2595) chứ không copy — nếu copy, harness và bridge sẽ chạy hai bản khác nhau
và metric sẽ nói dối.
</details>

<details><summary><b>E5 — <code>schema-exact</code> · key của Claude Code, không phải của OpenCode · 1 lượt</b></summary>

Tool `Edit` với `input_schema` **đóng** (`additionalProperties:false`) và key
**Claude Code**:
`{file_path, old_string, new_string, replace_all?}`.
User: `"Change MAX_ATTEMPTS = 3 to MAX_ATTEMPTS = 4 in bridge.mjs."`

**Cơ chế đang được đo:** OpenCode **dạy** model dùng `replaceAll` và `filePath`
(`RESEARCH-opencode-prompt.md` §1–2). Nếu model nghe theo prompt OpenCode, call sẽ
bị `badInput` và đốt một retry.

**Pass =** `badInput` rỗng ở attempt 1, tức mọi key trong `input` đều nằm trong
schema **sau khi `remapInput`**. **Fail =** có key lạ. **tokens_in ≈ 2100.**

Đây là case bảo vệ đúng lỗi im lặng đắt nhất đã ghi trong README (dòng 316).
</details>

<details><summary><b>E6 — <code>no-false-positive</code> · 0 tool · 1 lượt</b></summary>

Giống E1 nhưng `tools: []` và user message gợi hấn:
`"Run ls to check the files, then tell me what's there."`

**Cơ chế đang được đo:** bảng alias `TOOL_ALIASES` của bridge rộng; nếu nó quá
rộng, model gọi `Bash`/Read ở một lượt **không có tool nào**, và turn thành
`tool_use` với tool lạ.

**Pass =** `stop_reason:"end_turn"`, không `tool_use`. **Fail =** có bất kỳ
`tool_use` nào. **tokens_in = 1000.**

Không có case này thì mọi "cải thiện" tỉ lệ gọi tool có thể chỉ là cải thiện việc
**gọi nhầm**.
</details>

<details><summary><b>E7 — <code>empty-reply-detector</code> · 1 lượt, chạy mỗi repeat</b></summary>

Không phải một request riêng — **một assertion bổ sung áp lên E2 và E4**: reply
thô từ OpenCode phải **không rỗng**.

Đây là hiện tượng *"model đang cố gọi tool native, deployment bỏ"* trong log.
Bridge hiện ghi `RETRY_HINTS[1]` nói *"Your previous reply came back EMPTY"* — tức
đã **chấp nhận** hiện tượng này là bình thường và tốn một retry.
**Fail =** bất kỳ lần nào raw reply rỗng. **Chi phí = 0** (đếm trên reply đã có).

Cần bridge expose raw reply: hiện `discarded` chỉ giữ trong RAM và không ghi ra
file (§5.6, thay đổi 6).
</details>

<details><summary><b>E8 — <code>faithful-replica</code> · opt-in, đắt, chạy 1 lần/tuần</b></summary>

Bản sao của lỗi thật: 10 tool mô tả dài + `system` dài kiểu Claude Code +
mid-loop với **1 tool_result 20 000 ký tự** (gần mức cắt bảo vệ 72 000 ký tự).

**tokens_in ≈ 11 000** (đo được: 3851 ở tool_result 2 000 ký tự; cộng
~18 000 ký tự ÷ 2.8 ≈ 6 400).

**Pass =** cùng tiêu chí E4. **Vì sao vẫn cần:** lỗi thật xảy ra ở
`ptok=75517`. Không case nào ở trên tái hiện được mật độ đó. Đây là case bảo vệ
khỏi việc tối ưu cho một thế giới không tồn tại. **Chạy ≤1 lần/tuần.**
</details>

### 5.4 Cách tính tỉ lệ, và ngân sách n

```js
// verdict mỗi lượt: "pass" | "narration" | "retry" | "error" | "empty" | "nonjson"
const rate = (runs, kind) => runs.filter(r => r.verdict === kind).length / runs.length;

// Wilson 95% — dùng cho n < 20, clamp khi n = 0
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + z*z/n;
  const c = (p + z*z/(2*n)) / d;
  const h = z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / d;
  return [Math.max(0, c-h), Math.min(1, c+h)];
}
```

**Ngân sách n, thẳng thắn:**

| n | Độ tin cậy | Chi phí (7 case) |
|---|---|---|
| 1 | **không đủ.** 0/1 và 1/1 khác nhau vô hạn điểm phần trăm | 14 300 |
| 3 | thấy 0/3 vs 3/3. Không phân biệt được 50% với 85% | **43 000** |
| 5 | phân biệt được ~50% vs ~85% | **72 000** |
| 10 | mặc định cho case bạn thực sự đang sửa | **143 000** |

**Khuyến nghị:** chạy n=3 cho **mọi** case trước khi sửa gì (lấy baseline). Sau
đó chỉ chạy lại **case đã hỏng** với n=10, và chỉ chạy E8 mỗi tuần.
Toàn bộ chu kỳ sửa: **~43 000 + 143 000** token, thay vì đốt cả quota để đoán.

**Luôn chạy cùng lúc:** `E1` (control) và `E6` (chống gọi nhầm). Nếu E1 hỏng, phần
còn lại của lượt đo vô nghĩa và phải dừng.

### 5.5 Đánh đổi phải nói rõ

| Đánh đổi | Hệ quả |
|---|---|
| System prompt 75 ký tự thay vì system prompt thật của Claude Code | Harness **không** tái hiện nguyên nhân gốc. Đã đắn đổi bằng E8. |
| 3–10 tool thay vì 23 tool | Giảm tải theo `Order Matters` (§3.2) và `IFScale` (§2.2). **Đây là điểm nghiêng về một bên**: harness đo ở vùng dễ hơn thực tế, nên **tỉ lệ đo được là cận trên của tỉ lệ thật**. Nói rõ điều này khi báo cáo. |
| `tool_result` 2000 ký tự thay vì 20 000–72 000 | Cùng lý do |
| `effort` để `medium` (mặc định Claude Code) | Không đo ở `low`/`high`. Effort **có** ảnh hưởng tool discipline — `IFScale` §4.3 cho thấy model reasoning vượt rõ ở mật độ cao. Đừng đổi effort khi đo. |
| Không dùng Claude Code làm client | Mất đúng cái `<system-reminder>`/tool-result interleaving thật. Đã đưa 1 `<system-reminder>` vào E4. |

**Nguyên tắc báo cáo:** luôn in `tokens_in` đo được bằng `count_tokens` cạnh tỉ
lệ, để người đọc tự biết case nằm ở mật độ nào.

### 5.6 Tầng replay — 0 token, chạy mãi mãi

Đây là phần **rẻ nhất và bị bỏ sót**.

Bridge đã có mọi thứ cần để chấm lại offline, trừ dữ liệu thô:

- `extractJson`, `normalizeEnvelope`, `ENVELOPE_KEYS` — thuần, đã export (dòng 2583-2596)
- `buildTranscript` — thuần, đã export (dòng 2588)
- `looksLikeNarration` — thuần, đã export (dòng 2595)
- `validateInput`, `remapInput`, `resolveToolName` — dùng chung

**Còn thiếu duy nhất: reply thô từ model.** Không có gì được ghi ra file. Biến
`discarded` (dòng 1772) từ biến RAM thành append vào `bridge.raw.ndjson`:

```js
// trong runModel(), ngay sau khi res trả về — 0 token, chỉ ghi log
if (RAW_LOG) {
  appendFileSync(RAW_LOG, JSON.stringify({
    t: new Date().toISOString(), requestId, attempt,
    prompt_chars: promptText.length, raw: res.text
  }) + "\n");
}
```

Sau đó `score-replay.mjs` đọc file, chạy `extractJson` → `normalizeEnvelope` →
`looksLikeNarration`, và tái tạo **đúng** verdict của từng lượt — **không tốn
một token**. Sửa `NARRATION_ACTION`, `ENVELOPE_KEYS`, hay `validateInput` xong là
chấm lại toàn bộ lịch sử ngay.

**Chỉ cần ghi log khi `DEBUG_RAW=1`** để file không phình vô hạn.

### 5.7 E9 — kiểm chứng §4.2 (agent `system`), 1 lần gọi

Không phải case chất lượng, mà là **case giả thuyết**, và nó quyết định có nên
làm §4.2 hay không:

1. Thêm vào `opencode-config/opencode.json`:
   `{"agents":{"ccbridge":{"mode":"primary","system":"MARKER-ZQ7-ONLY-SENTENCE."}}}`
   — chỉ **một câu**, không `permissions` (tránh `403 FreeTierError`).
2. `GET /api/agent` → xác nhận `ccbridge` xuất hiện với `system` đúng marker.
   **0 token.**
3. `POST /api/session` → `POST /api/session/{id}/agent {"agent":"ccbridge"}`.
4. Một lần E2 với `max_tokens: 50` (~2 100 token).
5. **Kết luận:**
   - Reply chứa marker và **không** còn mô tả tool OpenCode → `system` của agent
     **thay** được base prompt. Đường này mở.
   - Reply không có marker → `/generate` không dùng agent. Đường §4.2 **chết**,
     dừng đầu tư vào nó.

**Chi phí: ~2 100 token + 0.** Đây là phép đo đáng giá nhất trong toàn bộ tài liệu
này vì nó kết thúc một hướng đi đã tốn công suy đoán.

---

## 6. Những gì đã thử và **không** giữ được (để không ai thử lại)

| Cách | Kết quả | Mức |
|---|---|---|
| `tools: {…: false}` | `403 FreeTierError` | CAUGHT UP (đo trước) |
| `permission` (object) | `403 FreeTierError` | CAUGHT UP (đo trước) |
| `permissions: deny` | Tắt cả free tier | CAUGHT UP (đo trước) |
| `system: ""` trong agent, khoá `agent` số ít | Nuốt vào `request.body`, không có tác dụng | CAUGHT UP (`RESEARCH-opencode-api.md`) |
| Thêm field bất kỳ vào body `/generate` | `additionalProperties: false` | CAUGHT UP (đo hôm nay) |
| `agents.<id>.tools` trong config | Khoá không tồn tại trong `Config.AgentEncoded` | CAUGHT UP (schema sống) |
| `experimental.primary_tools` | Có nhưng deprecated, chỉ giới hạn tool cho primary agent | CAUGHT UP (schema sống) |
| Thêm nhiều ràng buộc hơn vào `RESPONSE_PROTOCOL` | Có bằng chứng đo được là **giảm** tuân thủ (§2.1, §3.1) | CAUGHT UP |

---

## 7. Những gì **chưa** ai đo, kể cả tôi

| Câu hỏi | Vì sao chưa biết |
|---|---|
| `space-bunny-free` có thực sự bị prompt OpenCode kéo về phía tool của nó không | Cần so sánh cùng case, có và không có agent `system` → chính là E9 |
| `/generate` có resolve agent của session không | Không endpoint nào lộ ra; E9 là cách rẻ nhất |
| `opencode.ai/inference` có tôn trọng `response_format` không | Cần 1 lần gọi có payload khác thường |
| Con số "~7k token" thật sự | **Bridge không đọc usage upstream.** Mọi thứ từ `FIXED_OVERHEAD_TOKENS=12000` trở xuống là giả định |
| Model có thực sự **không đọc** phần lớn protocol không | Cần logprobs. Gateway OpenAI-compatible không chắc trả |
| Tỉ lệ thật của narration ở `ptok=75517` | Chỉ có một mẫu trong log. E8 là cách lấy mẫu thứ hai |
| Baseline hiện tại của E1–E7 | Chưa ai chạy. **Đây là việc nên làm đầu tiên** |

---

## 8. Hệ quả cho `bridge.mjs` — xếp theo value/cost

### Nhóm A — làm ngay, gần như miễn phí

| # | Thay đổi | Cơ chế | Rủi ro |
|---|---|---|---|
| **A1** | Thêm `appendFileSync` raw reply vào `bridge.raw.ndjson` khi `DEBUG_RAW=1` | Cho phép chấm lại mọi thay đổi sau này ở 0 token (§5.6) | File phình → ghi đè theo ngày. Rò rỉ nội dung người dùng ra đĩa → chỉ bật khi debug, phải nằm trong `.gitignore` |
| **A2** | Dựng `probe-reliability.mjs` theo §5, import hàm từ `bridge.mjs` (không copy regex) | Lần đầu có phép đo rẻ và tái dùng | Harness và bridge trôi khỏi nhau nếu ai sửa một bên → thêm test khẳng định import thật |
| **A3** | Chạy baseline E1–E7, n=3, **trước khi sửa gì** | Không có baseline thì mọi "cải thiện" sau này là vô nghĩa | 43 000 token |

### Nhóm B — rẻ, có cơ sở tài liệu

| # | Thay đổi | Cơ chế | Rủi ro |
|---|---|---|---|
| **B1** | Chạy **E9**. Nếu `agents.<id>.system` thay được base prompt của OpenCode, dùng nó cho protocol; giữ protocol trong transcript chỉ ở bản rút gọn | Đường duy nhất loại bỏ prompt xung đột thay vì thắng nó (§4.2). Anthropic cũng khuyến nghị loại bỏ chứ không phải chống lại | `/generate` có thể không dùng agent → mất ~2 100 token phí phạm. Nếu base prompt vẫn là tiền tố thì **tệ hơn hiện tại** vì thêm 7k token. Phải đọc kết quả E9, không đoán |
| **B2** | **Cắt bớt `RESPONSE_PROTOCOL`.** Đếm số ràng buộc; mục tiêu ≤8. Xoá trước: câu giải thích dài về vì sao envelope tồn tại, ví dụ lặp, và mọi câu trùng với `FINAL:` closer | `Instruction Stacking Collapse`: suy giảm phi tuyến, thiệt hại tập trung ở ràng buộc thứ 5–8; "valid JSON" là nút xung đột trung tâm (§2.1) | Một ràng buộc bị xoá là một failure mode mới mà ta chưa đo. **Bắt buộc chạy lại E1–E7 sau khi cắt** — không cắt mù |
| **B3** | Chuyển ví dụ envelope ra khỏi protocol, thành **schema cụt** + 1 ví dụ duy nhất | "Let Me Speak Freely?": thêm schema vào prompt làm điểm Claude-3-Haiku tụt 86.99 → 23.44 và sd 0.2 → 22.9 (§3.1) | Suy rút ra từ `claude-3-haiku-20240307`, **không phải** model của ta. Đo E5 trước/sau |
| **B4** | Khi có `tool_choice` cứng, **xoá hẳn** phần "Two accepted shapes / A) plain reply" khỏi protocol và chỉ chừa shape B | `tool_choice` là kênh có tài liệu (§1.3); cho model thấy shape A chính là mời nó chọn A. `bridge.mjs:850-856` đã in lệnh "Do not answer in text" | Nếu `tool_choice` không cứng thì **không** áp dụng. Điều kiện hoá theo `body.tool_choice` |

### Nhóm C — đắt, chỉ khi A+B không đủ

| # | Thay đổi | Cơ chế | Rủi ro |
|---|---|---|---|
| **C1** | Thử `providers.opencode.models["space-bunny-free"].body.response_format` | Đường JSON mode thật (§4.4) | Gateway OpenAI-compatible có thể bỏ qua hoặc từ chối. Schema Anthropic không dùng được ở đây. Rủi ro: **im lặng thất bại** — payload lạ bị bỏ qua và ta tưởng đã bật. Kiểm bằng cách nhìn reply còn prose hay không |
| **C2** | Chuyển sang `/prompt` | Xoá sạch vấn đề: không còn envelope, không còn narration, không còn alias (§4.5) | Mất toàn bộ lớp kiểm soát của `/generate`; phải tự quản lịch sử session; `deny` có gỡ tool khỏi catalog không — `UNVERIFIED` |
| **C3** | Hướng sang **programmatic tool calling** | Xoá đúng lỗi đau: serialise JSON (§1.5) | **Mở lại đường thực thi** mà thiết kế hiện tại cố ý đóng. Sandbox là bề mặt tấn công mới. Paper là preprint chưa phản biện, và 3/14 model tụt 20+ điểm |
| **C4** | Self-consistency (N lần gọi/lượt) | +17.9 điểm trên GSM8K (§3.4) | N× chi phí. Và **vô dụng** nếu lỗi là tất định theo hình thức — điều E1–E7 sẽ cho biết. Chỉ cân nhắc sau khi B2–B4 đã hết |

### Thứ **không** nên làm

- **Thêm câu vào `RESPONSE_PROTOCOL`.** Anthropic đã ghi rõ thang lái tool-trigger
  có hữu hạn và đã ở mức "stronger" (§1.3); stacking benchmark nói suy giảm theo số
  ràng buộc (§2.1). Thêm câu là chi tiền với bằng chứng đo được là điều sai.
- **Thêm few-shot.** Không có số liệu đáng tin cho tình huống này (§3.3). Nếu muốn
  thử, hãy thêm **một** cặp ví dụ và đo E1–E7 trước/sau — đừng thêm nhiều.
- **Hứa "schema ở cuối tốt hơn ở đầu".** Bằng chứng nói thứ tự phải theo **độ khó**,
  không theo vị trí (§3.2), và nghiên cứu đó không có model Claude frontier nào.

---

## 9. Phụ lục — toàn bộ URL đã dùng

**Tài liệu Anthropic**
- Structured outputs — https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Tool use with Claude (mục "When Claude uses tools", bảng token system prompt) —
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview

**OpenCode (đo trực tiếp)**
- Schema config sống — https://opencode.ai/config.json
- `GET /openapi.json` trên `127.0.0.1:4599` → `session.generate`
- `GET /api/agent` trên `127.0.0.1:4599` → trường `system`
- `POST /v1/messages/count_tokens` trên `127.0.0.1:8787` → số token của §5.2

**Nghiên cứu**
- Instruction Stacking Collapse — https://arxiv.org/html/2608.02639v1
- IFScale — https://arxiv.org/html/2507.11538v1
- Order Matters — https://arxiv.org/html/2502.17204v2
- Let Me Speak Freely? — https://arxiv.org/html/2408.02442v1
- The Bitter Lesson of Tool Calling — https://arxiv.org/html/2608.06370v1
- Self-Consistency (ICLR 2023) — https://arxiv.org/abs/2203.11171
- Gorilla discussion #606 — https://github.com/ShishirPatil/gorilla/discussions/606
- Reliable Constrained Generation with LLMs (đọc qua trích dẫn, **chưa** đọc
  toàn văn) — https://exascale.info/assets/pdf/mondal2025bigdata.pdf

**Không dùng / không có**
- Không tồn tại tài liệu Anthropic nào cho "prompt-based function calling".
- Không tìm thấy nghiên cứu định lượng nào về hai system prompt mâu thuẫn làm giảm
  tool calling.
- Không tìm thấy tài liệu Anthropic nào khuyến nghị "output token budget hint"
  trong prompt để tăng độ hợp lệ JSON.

---

## 10. Ghi chú phương pháp

Ba bài báo trong tài liệu này (Instruction Stacking Collapse, IFScale, Order
Matters) **không có model Claude frontier nào đúng loại ta dùng**. Kết luận của cả
ba đều được nêu kèm giới hạn đó nơi chúng được dùng. Trong ba bài ấy:
Instruction Stacking Collapse có Claude Sonnet 4.6; IFScale có
`claude-sonnet-4`, `claude-opus-4`, `claude-3.7-sonnet`, `claude-3.5-haiku`;
Order Matters **không có Claude nào**.

`space-bunny-free` là model free tier phía sau gateway OpenAI-compatible. Mọi
con số ở đây là **đường suy luận**, không phải đo trên đúng model. Đó chính là lý
do §5 tồn tại: đo trên đúng model, rẻ, và lặp lại được.