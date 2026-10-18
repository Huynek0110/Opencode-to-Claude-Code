# Nghiên cứu — làm cho model nhỏ tuân thủ protocol JSON tool-calling một cách đáng tin cậy

Ngày: 2026-10-17 · Phạm vi: `claude-code-bridge/bridge.mjs` · Người viết: subagent nghiên cứu, không sửa file nào ngoài file này.

---

## 0. Cách đọc file này

**Mức chắc chắn**

| Nhãn | Nghĩa |
| --- | --- |
| `CAUGHT UP` | Đọc trực tiếp từ tài liệu chính thức / spec / mã nguồn / registry, hoặc tự đo trên máy này. |
| `INFERRED` | Suy luận từ nguồn khác, blog, hoặc suy ra từ hành vi quan sát được. Chưa có nguồn trực tiếp. |
| `UNVERIFIED` | Chưa kiểm chứng được. Ghi rõ là không biết. |

**Loại nguồn** được ghi kèm mỗi trích dẫn: `[DOC]` tài liệu chính thức của nhà cung cấp · `[SPEC]` OpenAPI/schema được đọc từ hệ thống đang chạy · `[REG]` metadata npm/PyPI · `[BENCH]` benchmark/leaderboard có bài báo · `[PAPER]` preprint/ấn phẩm khoa học · `[SRC]` mã nguồn README · `[MEAS]` tự đo trong file này.

**Môi trường kiểm chứng cục bể** (`CAUGHT UP`, `[SPEC]`)

- `opencode --version` → **v2.0.29** (Windows, Node 24.20.0).
- OpenAPI spec lấy từ `GET http://127.0.0.1:4599/openapi.json` của chính server đang chạy (276 535 ký tự). Mọi khẳng định về `/api/session/...` dưới đây đến từ spec đó, **không** từ trang docs.
- Các phép đo về parser chạy trong `…\Temp\opencode\jsonrepair-probe\` với `jsonrepair@3.15.0` và `json5@2.2.3` cài từ npm; script chỉ `import` (read-only) từ `bridge.mjs`.

---

## 1. Hiện trạng: bridge đang ở đâu

Tóm tắt cơ chế hiện tại (`bridge.mjs`, dòng 16–28 trong docstring, và mã):

1. Claude Code → `POST /v1/messages` → `bridge.mjs`.
2. `buildTranscript()` biến mọi tool của Claude Code thành **văn bản**: JSON schema trong `# AVAILABLE TOOLS`, protocol trong `# RESPONSE_FORMAT`, hội thoại trong `# CONVERSATION`, một đoạn "FINAL: …" cộng thêm ở cuối.
3. `runModel()` gọi `POST /api/session/{id}/generate` của `opencode serve` với **duy nhất** `{ prompt }`.
4. `extractJson()` → `normalizeEnvelope()` → `resolveToolName()` → `remapInput()` → `validateInput()` → phát `tool_use` block, hoặc retry với `RETRY_HINTS[attempt]` + `correctionFor(kind)`.

Năm kiểu thất bại đã đo được, và **vì sao** chúng xảy ra (đây là điểm mấu chốt cho toàn bộ nghiên cứu):

| Kiểu | Cơ chế ở tầng trên | Nguồn của giới hạn |
| --- | --- | --- |
| Văn xuôi thay vì JSON | Model được huấn luyện theo Code Mode của OpenCode; system prompt do `opencode serve` tiêm vào (~7k token) quảng bá `shell/read/write/edit/subagent` như tool thật; không có gì trong payload ép tắt prefix đó. | Xem §4. |
| Rỗng (đang gọi tool native → bị deployment bỏ) | `generate` trả **chỉ** `{data:{text}}`; không có `parts`, không `stop_reason`. Thông tin bị hủy ở tầng upstream, bridge không quan sát được. | Xem §2.3. |
| Sai tên tool | Bảng alias hẹp có chủ đích; không có grammar ràng buộc tên. | Xem §4. |
| Sai schema `input` | `validateInput()` là subset JSON Schema tự viết; không có grammar ràng buộc kiểu. | Xem §2. |
| JSON lồng quá sâu / escape sai | Chỉ có `JSON.parse` + quét dấu ngoặc cân bằng; không có lớp sửa. | Xem §3. |

**Điểm mấu chốt:** Anthropic/OpenAI ép được JSON hợp lệ bằng **grammar-constrained decoding ở tầng sampling**. Bridge đang cố làm đúng việc đó bằng **prompt + regex + retry**. Phần lớn câu hỏi nghiên cứu này xoay quanh: có làm được "đúng việc đó" không, và nếu không thì làm gì thay thế.

---

## 2. Câu 1 — Structured output / constrained decoding

### 2.1 Các cơ chế có thật, theo tài liệu chính thức

**Anthropic — Structured outputs (`output_config.format`)** · `CAUGHT UP` · `[DOC]`
<https://platform.claude.com/docs/en/build-with-claude/structured-outputs>

- Trạng thái: **GA**. Request mang `output_config: { format: { type: "json_schema", schema: {...} } }`; kết quả JSON nằm trong text content block và **guaranteed** khớp schema.
- Cơ chế: constrained sampling với grammar đã compile.
- Giới hạn schema (trích nguyên văn, rút gọn): `object/array/string/integer/number/boolean/null`, `enum` (chỉ scalar), `const`, `anyOf`, `allOf` (trừ `allOf` với `$ref`), `$ref`/`$def`/`definitions` (không external `$ref`), `default`, `required`, `additionalProperties` (**bắt buộc phải là `false`**), string `format` (`date-time`, `time`, `date`, `duration`, `email`, `hostname`, `uri`, `ipv4`, `ipv6`, `uuid`), `minItems` chỉ 0 hoặc 1.
- **Không hỗ trợ**: schema đệ quy, enum phức tạp, external `$ref`, ràng buộc số (`minimum`/`maximum`/`multipleOf`), `minLength`/`maxLength`, `additionalProperties` khác `false`. Dùng sai → **400**.
- Giới hạn độ phức tạp: **20** tool `strict` / request, **24** optional param, **16** param dùng `anyOf`/type-array, timeout compile **180 s**, lỗi "Schema is too complex for compilation".
- Chi phí: grammar cache 24 h; **đổi `output_config.format` là invalidate prompt cache**; có thêm system prompt giải thích format → input token tăng nhẹ.

**Anthropic — Strict tool use (`strict: true` trên tool)** · `CAUGHT UP` · `[DOC]`
<https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use>

- Đặt `strict: true` cạnh `name`/`description`/`input_schema`. Guarantee: (a) `input` khớp `input_schema` tuyệt đối, (b) **`name` luôn hợp lệ** (nằm trong danh sách tool đã cấp).
- Dùng **cùng pipeline compile grammar** với structured outputs. Schema cache 24 h. HIPAA-ok nhưng **không được để PHI trong schema**.
- `computer_toolset`/`browser_toolset` không nhận `strict: true`.

**OpenAI — Structured Outputs (`strict: true`)** · `CAUGHT UP` · `[DOC]`
<https://platform.openai.com/docs/guides/structured-outputs>

- Responses API: `text.format = { type: "json_schema", name, schema, strict: true }`. Chat Completions: `response_format`.
- Subset schema **chặt hơn Anthropic**: mọi field phải nằm trong `required`; `additionalProperties: false` bắt buộc; root phải là object (không `anyOf` ở root); ≤ 5000 property, ≤ 10 tầng nest; tổng ≤ 120 000 ký tự tên/enum/const; ≤ 1000 enum value; **thứ tự key trong output giữ theo thứ tự schema**. Không hỗ trợ `allOf`, `not`, `if/then/else`, `dependentRequired`, `patternProperties`.
- Lưu ý đáng chú ý: tài liệu vẫn khuyên *"normally it's better to indicate in the prompt the JSON schema and how the fields should be populated"* — prompt vẫn có giá trị **ngay cả khi đã có constrained decoding**.
- Edge case phải xử lý: `status === "incomplete"` + `incomplete_details.reason === "max_output_tokens"` → output có thể cụt; content block loại `refusal`.

**vLLM** · `CAUGHT UP` · `[DOC]` <https://docs.vllm.ai/en/latest/features/structured_outputs/>

- **Cảnh báo quan trọng**: `guided_json`, `guided_regex`, `guided_choice`, `guided_grammar`, `guided_whitespace_pattern`, `structural_tag`, `guided_decoding_backend` **đã bị xoá ở v0.12.0**. Dùng `extra_body={"structured_outputs": {"json": …}}` hoặc `StructuredOutputsParams(json=…)`. Nếu tài liệu cũ/blog còn nói `guided_json` thì đó là thông tin cũ.
- Backend: `xgrammar` hoặc `guidance`(llguidance); mặc định `auto`. Structured outputs bật sẵn trong OpenAI-compatible server.
- `response_format: {type: "json_schema", json_schema: {name, schema}}` cũng được hỗ trợ.

**XGrammar** · `CAUGHT UP` · `[DOC]` <https://xgrammar.mlc.ai/docs/latest/>
- Bản docs đang phục vụ: **0.2.8**. Ba điểm tích hợp vào decoding loop: `fill_next_token_bitmask` → `apply_token_bitmask_inplace` → `accept_token`; quyết định dừng bằng `is_terminated`. Mask sinh ở CPU nên engine giấu được latency. Có API `StructuralTag` và `OpenAIToolCallSchema` — cho phép **ràng buộc chỉ vùng tool call, để phần prose tự do** (đúng bài toán của bridge nếu một ngày nào có decoding).
- Đã tích hợp vào SGLang, vLLM, TensorRT-LLM, MLC-LLM.

**llguidance** · `CAUGHT UP` · `[SRC]` <https://github.com/guidance-ai/llguidance>
- v1.0.0 từ 2025-06-23. Ràng buộc CFG bất kỳ, khoảng **50 µs CPU/token** với tokenizer 128k. Hỗ trợ: subset JSON Schema, regex, CFG dạng Lark. Đây chính là engine đằng sau **OpenAI Structured Outputs (JSON Schema only)**, và đã merge vào Chromium, vLLM, llama.cpp, SGLang.

**Outlines** · `CAUGHT UP` · `[DOC]` <https://dottxt-ai.github.io/outlines/latest/>
- Python. Tích hợp: vLLM, Transformers, llama.cpp, Ollama, MLX-LM, SGLang, TGI, OpenAI, Anthropic, Gemini.
- ⚠️ **Cảnh báo tên npm**: package `outlines` trên npm là **dự án khác** (`francoislaberge/outlines`, mô tả "Recognize drawn shapes", dừng ở 2022-06-23, 9 version). Bản thật nằm trên PyPI. Cùng loại bẫy với các ghi chú trong `AGENTS.md`.

**jsonformer** · `CAUGHT UP` · `[SRC]` <https://github.com/1rgs/jsonformer>
- 4 937 ★, MIT, push lần cuối **2024-02-24** (gần như ngừng). Cơ chế: wrapper quanh Hugging Face model, **tự điền các token cố định** và chỉ giao cho model sinh token nội dung. Hỗ trợ subset: number/boolean/string/array/object.

### 2.2 Bridge có dùng được không? — Trả lời: **không, ở tầng transport hiện tại**

Đây là phần quyết định nhất, và nó là **bằng chứng đo được**, không phải suy đoán. `CAUGHT UP` `[SPEC]`:

**1) Route mà bridge đang dùng không có chỗ nào để móc schema vào.**

`POST /api/session/{sessionID}/generate` — request body, nguyên văn từ spec:

```json
{ "type": "object",
  "properties": { "prompt": { "type": "string" } },
  "required": ["prompt"],
  "additionalProperties": false }
```

`additionalProperties: false` ⇒ gửi `response_format`, `structured_outputs`, `tools`, `system`, hay `model` đều bị từ chối. Response cũng chỉ có:

```json
{ "data": { "type": "object", "properties": { "text": { "type": "string" } },
            "required": ["text"], "additionalProperties": false } }
```

**2) Route agent (`/prompt`) cũng không nhận tool schema.** Body: `{ id, text, files, agents, skills, metadata, delivery, resume }`, `required: ["text"]`, `additionalProperties: false`. **Không có `tools`.**

**3) Cả spec 276 KB không có một tham số constrained-decoding nào.** Đếm bằng regex trên toàn bộ file spec:

```
json_schema : 0
response_format : 0
structured_outputs : 0
guided_json : 0
output_config : 0
strict : 0
```

**4) Không lấy được credential của provider để gọi thẳng.** `GET /api/provider` trả về đúng một provider: `id=opencode, name="OpenCode", env=[], npm=[]`. Spec chỉ có `PUT /auth/:id` (set credential), **không có GET** để đọc ra. Tức là nhánh "bỏ OpenCode, gọi thẳng endpoint OpenAI-compatible có `response_format`" **đang đóng** — không phải vì kỹ thuật mà vì thiếu key.

**5) Mâu thuẫn cần lưu ý khi nâng cấp.** Trang docs công khai <https://opencode.ai/docs/server/> liệt kê `POST /session/:id/message` với body `{ messageID?, model?, agent?, noReply?, system?, tools?, parts }` — **có `tools?`**. Trên binary v2.0.29 đang chạy, `/api/session/{id}/message` chỉ có **GET**, và POST route là `/api/session/{sessionID}/prompt` **không có `tools`**. Docs cũng bỏ qua prefix `/api`. Nghĩa là: khẳng định "OpenCode không nhận tool schema" **đúng cho 2.0.29**, nhưng docs đã mô tả một thế giới có nó. Xem §8, khuyến nghị N0.

### 2.3 Điều kiện để có thể dùng (đủ để kiểm tra lại sau này)

Ba điều kiện, theo thứ tự dễ kiểm tra nhất:

- **C1 — API surface mở ra.** `POST /api/session/{id}/generate` (hoặc route thay thế) nhận `response_format` / `structured_outputs` / `tools`. Kiểm tra bằng một lệnh:
  ```powershell
  # spec sống của opencode serve
  $r = Invoke-WebRequest http://127.0.0.1:4599/openapi.json -UseBasicParsing
  ([regex]::Matches($r.Content, 'response_format|structured_outputs|json_schema')).Count
  ```
  Khác 0 ⇒ mở đường. Vẫn bằng 0 ⇒ mọi kỹ thuật dưới đây vô dụng, đừng đầu tư.
- **C2 — Provider chịu structured output.** Provider phải là OpenAI-compatible hỗ trợ `response_format: json_schema` (OpenAI, vLLM ≥0.12 với `structured_outputs`, hoặc endpoint Anthropic hỗ trợ `output_config.format`). Cần key riêng — hiện không lấy được (mục 4 ở trên).
- **C3 — Bridge có thể hạ cấp schema về subset.** Claude Code và MCP đưa schema thô: có `minLength`, `anyOf`, `$ref`, thậm chí không có `additionalProperties`. Constrained decoding **từ chối** những thứ này (Anthropic: 400; OpenAI: subset chặt). Thuật toán hạ cấp đã được Anthropic công bố và rất dễ cài: (1) gỡ constraint không hỗ trợ, (2) **chèn constraint vào `description`** để thông tin không mất, (3) thêm `additionalProperties: false` vào mọi object, (4) lọc `format` về danh sách hỗ trợ. Anthropic SDK gọi đây là `transform_schema()`; bridge nên có bản riêng, không cần SDK.

**Nếu C1–C3 thỏa**, giá trị lớn nhất không phải "JSON hợp lệ" (bridge đã đạt phần lớn) mà là **loại bỏ cả ba lớp lỗi còn lại**: sai tên tool, sai kiểu/khoá `input`, và thoát chuỗi escape sai — vì Anthropic strict tool use guarantee cả `name` lẫn `input`, còn constrained decoding chặn ngay ở tầng token. Phần còn lại (model *chọn sai* tool, model từ chối) **không** được constrained decoding giải quyết, và đó là giới hạn của mọi kỹ thuật ở §2.

---

## 3. Câu 2 — Robust parsing

### 3.1 Thư viện tồn tại thật (đã kiểm tra registry, `CAUGHT UP` `[REG]`)

| Tên | Phiên bản | Giấy phép | Còn sống? | Ghi chú |
| --- | --- | --- | --- | --- |
| [`jsonrepair`](https://www.npmjs.com/package/jsonrepair) | 3.15.0 (2026-07-03) | ISC | ✅ 41 version, 1 maintainer (josdejong) | Dùng bởi jsoneditoronline.org. ESM + CJS + UMD + streaming. |
| [`json_repair`](https://pypi.org/project/json-repair/) (Python) | 0.64.0 | — | ✅ | Mô tả: *"Repair malformed JSON from LLMs"*. Có `--schema` (JSON-Schema-guided repair) và `--schema-repair-mode {standard,salvage}`. **Không dùng được từ Node.** |
| [`best-effort-json-parser`](https://www.npmjs.com/package/best-effort-json-parser) | 1.5.1 (2026-06-26) | BSD-2-Clause | ✅ 1 maintainer | Trả **partial data** thay vì bịa token; tự bóc fenced code block (` ```json `); expose `parse.lastParseReminding`. |
| [`json5`](https://www.npmjs.com/package/json5) | 2.2.3 (**2023-03-04**) | MIT | ⚠️ ngủ đông | Siêu tập JSON, không phải "repairer". |
| [`jsonc-parser`](https://www.npmjs.com/package/jsonc-parser) | 3.3.1 (2026-07-16) | MIT | ✅ Microsoft | Scanner/parser cho JSON có comment. |
| `json-repair` (tên npm) | — | — | ❌ | **Không tồn tại trên npm** (404). Tên trong đề bài nhiều khả năng là lẫn với `jsonrepair` hoặc với bản PyPI `json_repair`. |

Danh sách `jsonrepair` sửa được (nguyên văn README, `CAUGHT UP` `[SRC]`): thêm quote quanh key, thêm escape, thêm dấu phẩy, thêm ngoặc đóng, **sửa JSON bị cắt cụt**, single quote → double quote, quote lạ → `"`, khoảng trắng lạ → space thường, `None/True/False` → `null/true/false`, bỏ trailing comma, bỏ comment, **bỏ fenced code block**, bỏ `...` trong array, bỏ JSONP, bỏ escape của string đã escape, bỏ kiểu dữ liệu MongoDB, nối chuỗi `"a" + "b"`, gộp NDJSON thành array. Có streaming, xử lý tài liệu vô hạn.

**Điểm quan trọng: `jsonrepair` không hứa bỏ văn xuôi.** README không liệt kê "strip leading/trailing prose". Đo thực tế xác nhận (mục 3.2).

### 3.2 Đo thực tế: `extractJson` hiện tại vs `jsonrepair` vs `json5`

`CAUGHT UP` `[MEAS]`. 14 mẫu lấy đúng từ các kiểu thất bại bridge đã ghi trong comment và log.

```
--- fenced ```json envelope              bridge: OK     repair: OK
--- prose + envelope (bridge scan wins)   bridge: OK     repair: FAIL
--- fence with inner fence               bridge: OK     repair: OK
--- truncated mid-envelope               bridge: FAIL   repair: OK   <-- input C:/a.tx bị đóng ngoặc
--- single quotes                        bridge: FAIL   repair: OK
--- trailing comma                       bridge: FAIL   repair: OK
--- bad escape (Windows path)            bridge: FAIL   repair: OK   <-- nhưng SAI (xem 3.3)
--- unquoted keys                        bridge: FAIL   repair: OK
--- prose ONLY (narration)               bridge: FAIL   repair: null
--- empty                                bridge: FAIL   repair: THREW
--- whitespace only                      bridge: FAIL   repair: THREW
--- prose, JSON, trailing prose          bridge: OK     repair: FAIL
--- native-tool-call attempt             bridge: FAIL   repair: THREW
--- markdown list narration              bridge: FAIL   repair: THREW

=== totals / 14 ===
both ok : 2     bridge only : 2     repair only : 5     both fail : 5
```

Bảng so `json5` với `jsonrepair` trên cùng lớp lỗi cú pháp:

| input | `JSON5.parse` | `jsonrepair` + `JSON.parse` |
| --- | --- | --- |
| `{"a":1,}` trailing comma | OK | OK |
| `{'a':1}` single quote | OK | OK |
| `{a:1}` key không quote | OK | OK |
| `{"a":1} /* hi */` comment | OK | OK |
| fenced code block bọc JSON | **FAIL** | OK |
| `'Here you go:\n{"a":1}'` prose | **FAIL** | **OK nhưng sai** (xem 3.3) |
| `{"a":1` cắt cụt | **FAIL** | OK |
| `{"p":"C:\Users\x"}` escape hỏng | **FAIL** | **OK nhưng sai** (xem 3.3) |
| `{"a":1}{"b":2}` hai object | **FAIL** | **FAIL** |

**Kết luận 3.2:** `json5` bị loại (loại trailing comma/khác quá yếu, và không còn được bảo trì từ 2023). `jsonrepair` **bổ sung** cho `extractJson`, không thay thế: nó thắng 5 lớp lỗi mà `extractJson` bỏ, và thua 2 lớp lỗi (prose bao ngoài) mà `extractJson` đang xử lý đúng. Thứ tự đúng là **giữ `extractJson` làm parser chính, thêm `jsonrepair` làm lớp cứu cuối.**

**Hiệu năng** (`CAUGHT UP` `[MEAS]`) — không có vấn đề, và điều này phủ định một giả thuyết:

```
payload 24 066 ký tự
  bridge extractJson (envelope hợp lệ)  : 0.4 ms
  bridge extractJson (bản bị cắt cụt)  : 0.8 ms
  jsonrepair (bản bị cắt cụt)          : 3.5 ms
  bridge extractJson, nest sâu 200 tầng: 0.1 ms
  jsonrepair,          nest sâu 200 tầng: 0.9 ms
```

`extractJson` đã được viết lại thành single-pass với stack (comment trong file ghi lại: cách quét lại từ mọi `{` là O(n²) và đã đóng băng event loop 29 s trên input 80k). **Việc dùng `jsonrepair` không mang lại lợi ích hiệu năng nào.** Chi phí thực sự chỉ là 1 dependency.

### 3.3 Cảnh báo quan trọng nhất: repair **đổi cả nghĩa**, và có thể lọt qua validator

`CAUGHT UP` `[MEAS]`. Hai ca đo được, cả hai đều tạo ra output **đúng kiểu JSON và đúng schema** nhưng **sai nghĩa**:

```
1. escape hỏng trong đường dẫn Windows
   in : {"file_path":"C:\Users\Le Hung\a.txt"}
   out: {"file_path":"C:UsersLe Hunga.txt"}      <-- backslash bị nuốt, path sai

2. prose trước JSON
   in : Here you go:\n{"a":1}
   out: ["Here you go:",{"a":1}]                  <-- prose biến thành PHẦN TỬ MẢNG
```

Ca 1 là nguy hiểm với bridge: `validateInput()` chỉ kiểm tra `file_path` là `string` — chuỗi sai vẫn pass, rồi `Read` được gọi với một path không tồn tại. Đây đúng là loại lỗi mà `RESPONSE_PROTOCOL` đang cấm ("Never invent file contents"), chỉ là nó xuất hiện qua đường khác. Ca 2 tự nhiên bị chặn vì `normalizeEnvelope()` loại array, nhưng đó là may mắn, không phải thiết kế.

Ngược lại, `jsonrepair` **không** sửa được lỗi ngữ nghĩa — đo được:

```
{"file_path":123}       -> không đổi   (sai kiểu)
{"input":{}}            -> không đổi   (thiếu required)
{"name":"Readd"}        -> không đổi   (sai tên tool)
{"input":null}          -> không đổi   (input không phải object)
```

Nghĩa là ranh giới trách nhiệm vẫn đúng như bridge đã chia: **`jsonrepair` lo lớp cú pháp; `resolveToolName`/`remapInput`/`validateInput` lo lớp ngữ nghĩa.** Nhưng vì repair có thể *tạo ra* dữ liệu sai ở lớp ngữ nghĩa, nó phải được đánh dấu là "low trust".

---

## 4. Câu 3 — Prompt protocol cho tool calling

### 4.1 Anthropic: có tài liệu chính thức, và một phát hiện làm thay đổi thiết kế

**Có.** Trang `tool-use/overview`, mục *"When Claude uses tools"*, `CAUGHT UP` `[DOC]`:

> This boundary is steerable through your system prompt. If Claude isn't calling tools when you expect, a light instruction such as `"Use the tools to investigate before responding."` increases tool use. A stronger form such as `"Always call a tool first before responding."` pushes further.

**Phát hiện quan trọng nhất của toàn bộ nghiên cứu** — từ `define-tools`, mục *"Forcing tool use"*, `CAUGHT UP` `[DOC]`:

> Note that when you have `tool_choice` as `any` or `tool`, **the API prefills the assistant message** to force a tool to be used. This means that the models will not emit a natural language response or explanation before `tool_use` content blocks, **even if explicitly asked to do so**.

Tức là: **Anthropic không *nhắc* model phải gọi tool — API prefills assistant turn.** Đó là ràng buộc **cấu trúc**, không phải ràng buộc bằng prompt. `RESPONSE_PROTOCOL` của bridge đang cố làm bằng prompt thứ mà Anthropic làm bằng prefill. Đây là lý do gốc rễ khiến kiểu thất bại "văn xuôi thay vì JSON" tồn tại, chứ không phải vì bridge thiếu luật.

Và vì `tool_choice: any` cũng bỏ qua thinking, nên *"Forcing a tool also skips thinking on every model that accepts forced tool use"* — bridge không có tầng này nên không bị ảnh hưởng.

**Hệ quả trực tiếp cho bridge** (`CAUGHT UP` `[SPEC]` + đọc mã): `/generate` chỉ nhận `prompt: string` ⇒ **không thể prefill assistant turn**. Ràng buộc cấu trúc duy nhất bridge còn lại là hậu kiểm ở cuối:

- `tool_choice: {type:"tool", name}` → `throw new EmptyTurn(...)` nếu model không gọi đúng tên. **Có ràng buộc cấu trúc.** ✔
- `tool_choice: {type:"any"}` → chỉ có `needsTool` retry + `toolChoiceLines`. **Không có ràng buộc cấu trúc** — nếu hết attempt và model vẫn chỉ trả văn xuôi, `handleMessages` rơi vào `nothingUsable` và ném `EmptyTurn` (400). Đây là hành vi đúng, nhưng **thông báo lỗi không mang theo nội dung model đã nói**, nên người dùng thấy 400 trống. Xem khuyến nghị N6.

### 4.2 Anthropic: system prompt tool-use chính thức (mẫu tham chiếu)

`CAUGHT UP` `[DOC]` — nguyên văn template Anthropic tự dựng khi có `tools`:

```
In this environment you have access to a set of tools you can use to answer the user's question.
{{ FORMATTING INSTRUCTIONS }}
String and scalar parameters should be specified as is, while lists and objects should use JSON format.
Note that spaces for string values are not stripped. The output is not expected to be valid XML and is
parsed with regular expressions.
Here are the functions available in JSONSchema format:
{{ TOOL DEFINITIONS IN JSON SCHEMA }}
{{ USER SYSTEM PROMPT }}
{{ TOOL CONFIGURATION }}
```

Ba điều đáng chú ý khi so với `RESPONSE_PROTOCOL` của bridge:

1. Anthropic **không** dạy "đừng mô tả thay vì hành động". Với kênh tool native, văn xuôi đi kèm là **miễn phí** — `tool_use` block vẫn xuất hiện, nên lời dạy đó là vô nghĩa. Luật này của bridge chỉ đúng **vì giao thức mô phỏng không có kênh hành động riêng**.
2. Anthropic cũng **không** cấm text kèm theo tool call; trang `define-tools` mục *"Model responses with tools"* mô tả việc Claude thường bình luận trước khi gọi tool là **bình thường và tốt** cho trải nghiệm người dùng.
3. Phần định dạng tham số được giao cho **grammar** (`String and scalar … should be specified as is`), không phải cho prompt.

→ Kết luận: luật *"Never DESCRIBE an action instead of taking it"* của bridge **không có tiền lệ trực tiếp từ Anthropic/OpenAI**, vì lý do đúng đã nêu. Nó là điều chỉnh đúng cho bối cảnh không có kênh tool — nhưng phải được trình bày là thiết kế riêng, không phải là quy tắc vendor.

### 4.3 Anthropic: symptom → fix (bảng chẩn đoán chính thức)

`CAUGHT UP` `[DOC]` <https://platform.claude.com/docs/en/agents-and-tools/tool-use/troubleshooting-tool-use>. Ánh xạ sang bridge:

| Triệu chứng (Anthropic) | Nguyên nhân | Cách sửa (Anthropic) | Áp dụng cho bridge |
| --- | --- | --- | --- |
| Claude never calls your tool | Trùng tên tool / schema quá chung | Kiểm tra trùng tên; thêm `input_examples` | Không có `input_examples` trong `buildTranscript` — mở đường N5 |
| Claude calls with wrong parameter types | Schema mơ hồ | `strict: true` **hoặc** `input_examples` | Không có `strict`; `input_examples` là lựa chọn rẻ |
| Claude invents tool parameters | Over-generation không có strict | `strict: true` | `validateInput` chặn hậu kỳ, tốn 1 retry thay vì 0 |
| Claude flags tool results as prompt injection | Chính bạn đặt instruction vào `tool_result` | Chuyển instruction ra user turn / mid-conversation system message | Bridge **đã fence `<tool_result>`** và cấm obey — đúng hướng |
| String comparison on tool input fails | Escape khác nhau giữa các version model | `JSON.parse()`; **không bao giờ** raw-string-match trên input đã serialize | Bridge `resolveToolName` so khớp *tên*, không so chuỗi input — đúng |

### 4.4 BFCL: benchmark duy nhất đo đúng bài toán "prompt thay tool channel"

`CAUGHT UP` `[BENCH]` <https://gorilla.cs.berkeley.edu/leaderboard.html>

- BFCL phân biệt rõ hai chế độ trên bảng xếp hạng:
  > **FC** = native support for function/tool calling.
  > **Prompt** = walk-around for function calling, using model's normal text generation capability.
  > Format sensitivity test cases are only supported for **prompt (non-FC) models**.

  Đây chính xác là vị trí của `space-bunny-free` sau bridge: cột **Prompt**. Và BFCL dành riêng một hạng mục để đo mức nhạy cảm đó — tức là hướng nghiên cứu của bài toán bridge **được cộng đồng công nhận là có thật**, chỉ là kết quả luôn kém hơn FC.
- BFCL V4 (cập nhật 2026-04-12), commit đánh giá `f7cf735`, tái lập bằng `pip install bfcl-eval==2025.12.17`. Bài báo ICML 2025 (Patil, Mao, Ji, Yan, Suresh, Gonzalez).
- BFCL V4 Format Sensitivity (blog 17) dựng **26 biến thể prompt** trên 5 chiều: `return_format` (python/json/verbose_xml/concise_xml), `function_doc_format`, `has_tool_call_tag`, `prompt_format` (plaintext/markdown), `prompt_style`; đánh giá **39 model**. Hai failure mode được ghi lại: (a) không tuân thủ kiểu tham số — schema yêu cầu `integer`, model trả `int`; (b) **lồng container sai** — yêu cầu bọc mọi call trong một `<functions>`, model bọc *từng* call riêng.

  → (a) chính là `validateInput` của bridge đang bắt; (b) là hình thái của "JSON lồng nhau quá sâu" mà bài toàn nêu. Đáng chú ý: failure mode là **prompt-format-dependent**, tức cải thiện prompt *có* giá trị đo được — nhưng cũng nghĩa là thay đổi prompt tùy tiện có thể làm tệ hơn.
- **Prompt mặc định của BFCL V1** (nguyên văn, lấy từ blog 17) là mẫu gần với `RESPONSE_PROTOCOL` nhất mà tìm được:

  > You should only return the function calls in your response. […] You **SHOULD NOT include any other text** in the response.
  > At each turn, you should try your best to complete the tasks requested by the user within the current turn. Continue to output functions to call until you have fulfilled the user's request to the best of your ability. **Once you have no more functions to call, the system will consider the current turn complete** and proceed to the next turn or task.

  Câu cuối chính là một **stop condition viết thẳng trong prompt** — nguồn cho khuyến nghị N3 ở §8.

---

## 5. Câu 4 — Retry / correction prompt

### 5.1 Bằng chứng ủng hộ

**Anthropic, chính thức** (`handle-tool-calls`, mục *"Invalid tool name"*) `CAUGHT UP` `[DOC]`:

> However, you can also continue the conversation forward with a `tool_result` that indicates the error, and Claude will try to use the tool again with the missing information filled in […] **If a tool request is invalid or missing parameters, Claude will retry 2-3 times with corrections before apologizing to the user.**

Và về cách viết lỗi:

> **Write instructive error messages.** Instead of generic errors like `"failed"`, include what went wrong and what Claude should try next (for example, `"Rate limit exceeded. Retry after 60 seconds."`). This gives Claude the context it needs to recover or adapt without guessing.

→ Điều này **xác nhận** thiết kế hiện tại của bridge: `correctionFor("names")` nêu đích danh tên sai và liệt kê đúng danh sách hợp lệ; `correctionFor("schema")` nêu lỗi validate cụ thể. Việc chia 5 loại lỗi (`narrated`/`envelope`/`names`/`shape`/`schema`) thay vì một lời nhắc chung là đúng hướng dẫn chính thức.

**Con số "2-3 lần"** cũng gần với `MAX_ATTEMPTS = 3` của bridge. Lưu ý: con số đó là của Claude với kênh tool native và lịch sử hội thoại đầy đủ; bridge không có điều kiện đó (mục 5.3).

### 5.2 Bằng chứng phản đối — và đây là phần quan trọng hơn

**arXiv 2601.15625** — *Robust Tool Use via Fission-GRPO: Learning to Recover from Execution Errors*, **ACL 2026 Main** `CAUGHT UP` `[PAPER]` <https://arxiv.org/abs/2601.15625>

> Large language models (LLMs) can call tools effectively, yet they remain brittle in multi-turn execution: **after a tool-call error, smaller models often fall into repetitive invalid re-invocations instead of interpreting the feedback and recovering.** This failure mode persists because current training paradigms do not explicitly teach models how to recover from execution errors.

Kết quả: Fission-GRPO nâng error-recovery rate của Qwen3-8B thêm **+5.7% tuyệt đối**, accuracy tổng 42.75% → 46.75% trên BFCL v4 Multi-Turn; generalize sang TAU-Bench / TAU2-Bench với增益 tới +17.4%. Đây là bằng chứng định lượng rằng **"lặp lại lỗi" là hành vi mặc định của model nhỏ sau khi nhận feedback**, và phải có can thiệp mới sửa được.

**arXiv 2509.18847** — *Failure Makes the Agent Stronger: Structured Reflection for Reliable Tool Interactions*, **ACL** `CAUGHT UP` `[PAPER]` <https://arxiv.org/abs/2509.18847>

> Current self-reflection practices rely on heuristic prompts or one-way reasoning: the model is urged to 'think more' instead of learning error diagnosis and repair. **This is fragile in multi-turn interactions; after a failure the model often repeats the same mistake.**

Cùng kết luận, độc lập, và là lý do paper đó đề xuất biến việc chẩn đoán lỗi thành **hành động trainable** (Reflect → Call → Final) thay vì một lời nhắc heuristic.

**arXiv 2608.05778** — *When Do Prompt-Side Agent Playbooks Transfer?* `CAUGHT UP` `[PAPER]` <https://arxiv.org/abs/2608.05778>

> On TAU2-Bench, a prespecified aggregate contrast supports a modest average matched-domain advantage, but **global Holm correction retains only one of 135 route-level effects** […] one artifact–runtime pairing preserves useful first-try heuristics while producing **repeated queries, delayed stopping, and substantial cost inflation** after a context-runtime shift.

→ Hướng dẫn tự sửa bằng prompt **có** tác dụng, nhưng hiệu quả **nhạy cảm với môi trường** và có thể *tăng* chi phí. Đây là lý do mọi thay đổi protocol ở §8 đều phải kèm đo lại.

### 5.3 Một điểm mấu chốt về cấu trúc retry của bridge

Bridge gửi `transcript + RETRY_HINTS[attempt] + retryNote` qua `runModel`. Vì `/generate` **không ghi lịch sử session** (mô tả route: *"Generate transient text from the current session context without mutating session history"*, `CAUGHT UP` `[SPEC]`), **model không có ký ức nào về lượt thất bại trước**. Nghĩa là:

- Retry của bridge **không phải** là "gửi lại câu trả lời rỗng" — đây là điều Anthropic cảnh báo phải tránh (`handling-stop-reasons`: *"Don't retry empty responses without modification: Sending the empty response back won't help"*). Nó là "gửi lại cùng prompt cộng thêm chỉ dẫn". An toàn hơn hẳn.
- Nhưng nó cũng nghĩa là **chỉ dẫn sửa là tín hiệu duy nhất mà model có**. `RETRY_HINTS` là hằng số theo chỉ số attempt, không đổi theo attempt trước, nên ở attempt 2 model không biết nó *đã* được nhắc một lần rồi. Đây chính là hình dạng "heuristic prompt" mà hai paper trên chỉ ra là dễ dẫn tới lặp lại lỗi.
- Điều bridge **làm đúng và nên giữ**: cơ chế `best` (giữ attempt tốt nhất theo `tools.length * 1000 + text.length`) là một lưới an toàn thực tế, vì nó không phụ thuộc model tự sửa.

**Điều không biết:** không có nguồn công khai nào đo **hiệu quả của một lời sửa dạng văn bản thuần** (không có lịch sử hội thoại) trên một model nhỏ cụ thể. Các benchmark đo thì có cấp agent loop. Đây là khoảng trống thật; mọi con số "sẽ giúp bao nhiêu %" ở §8 đều là **ước lượng cần đo tại chỗ**, không phải số liệu có sẵn.

---

## 6. Câu 5 — Model nhỏ và agentic loop

### 6.1 Model nhỏ hỏng ở đâu

| Bước | Bằng chứng | Mức |
| --- | --- | --- |
| Chọn đúng tool / có cần gọi tool không | BFCL tách riêng hạng mục *Irrelevance* (đánh giá việc model **không** gọi tool khi không nên) và *Hallucination Measurement/RelScore*; BFCL V3 thêm *Missing Functions* (200) — model phải nhận ra không có function nào đáp ứng, và *Implicit Action* | `CAUGHT UP` `[BENCH]` |
| Chuỗi hành động dài | τ-bench (arXiv 2406.12045): *"even state-of-the-art function calling agents (like gpt-4o) succeed on **<50% of the tasks**, and are quite inconsistent (**pass^8 <25%** in retail)"* | `CAUGHT UP` `[PAPER]` |
| **Hồi phục sau lỗi** | arXiv 2601.15625: model nhỏ *"fall into repetitive invalid re-invocations instead of interpreting the feedback and recovering"* | `CAUGHT UP` `[PAPER]` |
| **Nhận biết đã xong** | arXiv 2606.09863 (xem 6.2) | `CAUGHT UP` `[PAPER]` |
| Bám format khi đổi prompt | BFCL V4 Format Sensitivity, 26 biến thể × 39 model; và: *"Format sensitivity test cases are only supported for prompt (non-FC) models"* | `CAUGHT UP` `[BENCH]` |

Điểm đáng chú ý: trong bốn dòng trên, **ba dòng đầu là bài toán tương tác, chỉ một dòng là bài toán format**. Với mô hình của bridge (prompt emulation), kiểu thất bại *đo được* nghiêng hẳn về format/naming/schema, và đó cũng chính là kiểu mà constrained decoding ở §2 **loại bỏ được hoàn toàn**. Điều này làm §2 trở nên đáng giá hơn một con số phần trăm nào đó.

### 6.2 "Nói thay vì gọi" — có nghiên cứu riêng, và nó là vấn đề *phát hiện*, không chỉ *sửa*

**arXiv 2606.09863** — *From Confident Closing to Silent Failure: Characterizing False Success in LLM Agents*, **FAGEN@ICML 2026** `CAUGHT UP` `[PAPER]` <https://arxiv.org/abs/2606.09863>
(Đơn tác giả: Laksh Advani. Đã đọc abstract, chưa đọc toàn văn.)

> LLM agents can fail silently by **asserting task completion when the environment state shows otherwise.** […] False success is common but varies by setting: **45–48% of failures in single-control tau2-bench domains, 3% in dual-control telecom, and 75.8%** among AppWorld self-assessing coding-agent trajectories with explicit status claims.
> **LLM judges fail reliably**: no configuration across 5 judges, 5 prompt strategies, and full task specifications exceeds **AUROC 0.65** on tau2-bench, and the same judges reach only **0.54 AUROC** on AppWorld API-call traces. Judges rely on surface completion proxies — confident closing language […] rather than verified state changes.
> **Lightweight TF-IDF detectors achieve task-disjoint AUROC 0.83 on tau2-bench and 0.95 on AppWorld**, recovering **4–8× more false successes** than the best judge at the same flag rate with **3 300× lower latency**.

Đây là bài báo đúng cho câu hỏi của bài toàn. Bốn kết luận áp dụng thẳng:

1. **False success là phổ biến, không phải hiếm.** `looksLikeNarration` + `EmptyTurn` của bridge đang chống đúng một biến thể của nó.
2. **Đừng dùng LLM judge để phát hiện.** 5 judge × 5 prompt ≤ AUROC 0.65. Bridge đã không làm điều này — nhưng cũng nghĩa là không được đề xuất thêm.
3. **Detector bề mặt rẻ, được hiệu chuẩn theo domain, tốt hơn judge nhiều lần.** TF-IDF, AUROC 0.83–0.95, rẻ hơn 3300×. Đây là hướng thay thế đúng cho `looksLikeNarration`.
4. **"Confident closing language" chính là tín hiệu.** Paper nói rõ judge dựa vào *confident closing language*. Đó là đặc trưng mà regex hiện tại không bắt (mục 6.3).

### 6.3 Một lỗi cụ thể đo được trong `looksLikeNarration`

`CAUGHT UP` `[MEAS]`. `looksLikeNarration` **không** được export nên tôi chép nguyên văn regex vào script và chạy trên 7 mẫu:

```
MISSED    | the example in bridge.mjs's own docstring
            "Continuing to read the rest of bridge.mjs, and in parallel kicking off research…"
MISSED    | the example in NARRATION_CORRECTION
            "Now I will read the file and then run the tests."
DETECTED  | starts with 'Okay' (the shape the regex targets)
            "Okay, continuing with the remaining files in parallel."
MISSED    | markdown list, no hedge
            "- Reading bridge.mjs\n- Then research"
MISSED    | announces + stops
            "I'll check the config now."
MISSED    | real final answer that happens to contain 'will'   <-- đúng (true negative)
MISSED    | long narration (>1200 chars)
            "Okay, continuing. xxxx…"
```

Hàm chỉ bắt được **1/7**, và mẫu nó bắt được là mẫu duy nhất **có tiền tố "Okay,"**. Hai mẫu đầu là chính là ví dụ được viết trong docstring của hàm và trong `NARRATION_CORRECTION` — tức là **ví dụ minh hoạ không khớp với regex đang kiểm nó**. Nguyên nhân: điều kiện `^\s*(ok|okay|sure|got it|alright)\b` là một cổng chặn cứng, trong khi dấu hiệu thật (thì tương lai: `continuing`, `now i`, `i'll`, `kicking off`) nằm ở **phần sau** câu.

Hệ quả thực tế: nhánh `narrated` — vốn được `handleMessages` ưu tiên phân loại trước `envelope` — gần như không bao giờ kích hoạt; và khi không kích hoạt thì lời sửa gửi cho model là *"Your last reply was not a JSON envelope"* thay vì *"describing an action performs none of it"*, tức là **đúng cái thông điệp sai** cho nguyên nhân đúng.

Cần nói rõ: tôi **không biết** tỉ lệ thực tế của 7 mẫu này trên `space-bunny-free`. Đây là bằng chứng về **logic của regex**, không phải về tần suất.

---

## 7. Câu 6 — Stop condition: "xong" vs "chưa làm gì"

### 7.1 Chuẩn của Anthropic cho `stop_reason`

`CAUGHT UP` `[DOC]` <https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons>. Giá trị: `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`, `model_context_window_exceeded`. **Không có giá trị nào cho "model bị kẹt"** — Anthropic phân biệt bằng cách *ép cấu trúc* (prefill ở `tool_choice: any/tool`, xem §4.1), không phân biệt bằng tín hiệu.

Tài liệu còn mô tả một hiện tượng mà bridge chắc chắn sẽ gặp, và là hiện tượng mà bridge **đã xử lý đúng một phần**:

> **Empty responses with `end_turn`**: Sometimes Claude returns an empty response (exactly 2–3 tokens with no content) with `stop_reason: "end_turn"`. This typically occurs when Claude interprets that the assistant turn is complete, **particularly after tool results.**
> Common causes: adding text blocks immediately after tool results […]; sending Claude's completed response back without adding anything.
> **How to prevent:** 1. *Never add text blocks immediately after tool results.* 2. *Don't retry empty responses without modification.* 3. *Use continuation prompts as a last resort* — only if the fixes above don't resolve it.

Ba khuyến nghị này, đối chiếu với bridge:

1. *"Never add text blocks immediately after tool results"* — bridge **đã tuân thủ**: `buildTranscript` phát `<tool_result>` rồi mới tới text, và chỉ thêm text nếu Claude Code gửi kèm. Không cần sửa.
2. *"Don't retry empty responses without modification"* — bridge không vi phạm, vì `/generate` stateless (§5.3).
3. *"Use continuation prompts"* — bridge dùng đúng cơ chế này (`RETRY_HINTS`), nhưng gộp chung với cả các lỗi khác thay vì chỉ cho empty turn.

### 7.2 Chuẩn của BFCL cho stop condition viết bằng lời

`CAUGHT UP` `[BENCH]`. Prompt BFCL V1 (mục 4.4) đặt luật dừng thành **một câu quy tắc trong prompt**:

> **Once you have no more functions to call, the system will consider the current turn complete** and proceed to the next turn or task.

Đây là mẫu đơn giản, đo được, và — quan trọng — **đối xứng**: nó nói rõ điều kiện *kết thúc* chứ không chỉ điều kiện *hành động*. `RESPONSE_PROTOCOL` của bridge hiện nói rõ điều kiện hành động ("To act, put the call in tools") nhưng **không nói rõ điều kiện kết thúc** ("khi nào thì được phép chỉ trả text"). Đây là một khoảng trống cụ thể.

### 7.3 Chuẩn cho *phát hiện* model bị kẹt

Không có chuẩn vendor nào. Bằng chứng tốt nhất là arXiv 2606.09863 (§6.2):

- Dùng **tín hiệu bề mặt** (confident closing language) làm **triage**, không làm phán quyết.
- Hiệu chuẩn theo domain: detector TF-IDF phải được đo trên chính domain của bạn.
- **Không** dùng LLM judge (AUROC ≤ 0.65).

Bridge hiện đã có một phiên bản rất sơ khai của đúng mô hình này: `midToolLoop` (đọc từ request — user message cuối chỉ gồm `tool_result` block) + `looksLikeNarration`. Phần `midToolLoop` là **tín hiệu cấu trúc**, mạnh hơn hẳn tín hiệu văn bản, và nên là trục chính. Phần văn bản chỉ nên là lớp phụ.

---

## 8. Hệ quả cho bridge.mjs

Xếp theo **giá trị / công sức**. Mỗi mục ghi rõ bridge.mjs có dùng được không.

---

### N0 — Gắn một "canary" phát hiện thay đổi API của OpenCode · *chi phí ~0 · giá trị: giữ cho các mục còn lại còn đúng*

**Dùng được không:** đây là guard, không phải kỹ thuật.

Docs công khai đã mô tả `tools?` cho route message trong khi binary v2.0.29 không có (§2.2 mục 5). Bridge đang chạy trên một binary cụ thể nhưng giả định của nó về khả năng của OpenCode sẽ **âm thầm sai** khi nâng cấp.

- Thêm vào `GET /health` (đã là JSON, không ảnh hưởng client) một trường đo từ spec: `constrained_decoding_params: <số lần khớp regex /response_format|structured_outputs|json_schema|guided_json/ trong /openapi.json>`.
- Rủi ro: gần như không có. `/health` chỉ đọc trạng thái local, không gọi upstream.

---

### N1 — Thêm `jsonrepair` làm lớp cứu cuối, **có gắn cờ low-trust** · *giá trị cao · chi phí thấp · rủi ro: dữ liệu sai âm thầm*

Đo được (§3.2): thêm **5/14** lớp lỗi mà `extractJson` hiện bỏ — cắt cụt, single quote, trailing comma, key không quote, escape hỏng. Đây gần như chính xác là danh sách "kiểu thất bại" bài toàn nêu (escape sai, JSON lồng/cắt).

**Cách làm cụ thể trong `extractJson`:** thêm một nhánh sau vòng quét span cân bằng, trước `return null`:

```
try { return tryParse(jsonrepair(text)) } catch { return null }
```

**Ba ràng buộc bắt buộc** (không phải tuỳ chọn — chúng xuất phát từ phép đo ở §3.3):

1. **Chỉ chạy sau khi `JSON.parse` thuần và quét span đã thất bại.** Không bao giờ thay thế parser chính — `jsonrepair` **thua** 2/14, toàn là lớp prose mà `extractJson` đang làm đúng.
2. **Chặn array.** `jsonrepair` biến prose thành phần tử mảng (`["Here you go:",{"a":1}]`). `normalizeEnvelope` đã loại array, nhưng hãy chặn ngay tại `extractJson` để nhánh này không bao giờ thành công một cách nửa vời.
3. **Gắn cờ và mặc định là bỏ.** Trả kèm `{ repaired: true }`. `handleMessages` nên coi `repaired` là **cần giải thích**, không phải bình thường. Đặc biệt: **không** để một `file_path` đã bị repair đi thẳng tới `Read`, vì phép đo cho thấy `C:\Users\Le Hung\a.txt` → `C:UsersLe Hunga.txt` — hợp lệ về kiểu, sai về nghĩa, và `validateInput` không bắt được.

**Rủi ro:** thêm 1 dependency (`jsonrepair`, ISC); hành vi phụ thuộc bên thứ ba trong đường parse; khả năng sinh dữ liệu sai đã đo được và đã có chốt chặn.

---

### N2 — Bỏ `looksLikeNarration` dạng regex, thay bằng detector hai tầng theo mô hình false-success · *giá trị trung bình-cao · chi phí thấp · rủi ro: false positive tốn retry*

Đo được (§6.3): regex hiện tại bắt **1/7** mẫu, và bỏ lỡ chính ví dụ trong docstring của nó.

Tầng 1 — **tín hiệu cấu trúc, giữ nguyên và nâng lên hạng chính.** `midToolLoop` (user message cuối chỉ gồm `tool_result`) là thứ duy nhất bridge biết chắc. Khi `midToolLoop` đúng và model trả văn xuôi **không kèm tool**, đó gần như luôn là false success theo định nghĩa của arXiv 2606.09863, bất kể nội dung câu. Đây là đường kiểm lỗi đáng tin nhất và gần như miễn phí.

Tầng 2 — **tín hiệu bề mặt, chỉ để ghi log/telemetry trước.** Thay `\b(continuing|will |i'll |...)\b` bằng: điều kiện thì tương lai ở bất kỳ vị trí nào (không cổng chặn tiền tố) **và** cụm "closing language" (*done, that's complete, let me know if…*). Đây đúng là loại tín hiệu paper 2606.09863 đo được ở AUROC 0.83.

**Quy tắc an toàn:** giữ `> 1200` để né false positive trên câu trả lời dài, và **đo tỉ lệ false positive trên chính log của bạn** trước khi cho phép nó ném lỗi. Bridge đã có `logRequest("narrated", …)` — hãy log cả khi *không* ném, để có dữ liệu.

**Rủi ro:** false positive ăn một retry (`~` 1 lần gọi upstream). Bù lại: hiện tại false *negative* làm hỏng cả vòng retry, vì model nhận nhầm thông điệp "không phải JSON" cho một câu văn xuôi hoàn toàn hợp lệ.

---

### N3 — Thêm luật stop condition đối xứng vào `RESPONSE_PROTOCOL` · *chi phí ~0 (vài chục token mỗi lượt) · rủi ro: tăng nhẹ input token*

`RESPONSE_PROTOCOL` nói rõ **khi nào phải hành động** nhưng không nói **khi nào được dừng**. BFCL V1 có đúng một câu cho việc này (§7.2). Thêm vào, đối xứng với luật hiện có:

> Bạn đã xong khi: không còn tool nào cần chạy và câu trả lời đã đủ. Khi đó trả `{"text": "..."}` **không kèm khoá "tools"**, và coi như lượt đó kết thúc. Từ lượt sau lời sẽ không tự tiếp tục.

Chi phí thật: vài chục token × mọi lượt, không có prompt caching (bridge đã ghi nhận điều này ở comment `buildTranscript`).

**Rủi ro:** rất thấp về hành vi. Rủi ro thật là **không đo được** — paper 2608.05778 cho thấy thay đổi prompt có thể tạo "repeated queries, delayed stopping, and substantial cost inflation". Vì vậy phải đo trước/sau (xem N7).

---

### N4 — Làm lượt retry thứ 2 biết mình đã được nhắc lần 1 · *giá trị trung bình · chi phí ~0 · rủi ro: câu chữ*

Hai paper (2601.15625, 2509.18847) cùng chỉ ra: lỗi phổ biến của model nhỏ sau khi nhận feedback là **lặp lại lỗi cũ**. `RETRY_HINTS[1]` và `RETRY_HINTS[2]` là hằng số theo chỉ số, nên attempt 2 không biết đã có một chỉ dẫn trước đó.

- Làm `RETRY_HINTS[2]` **tham chiếu ngược**: kiểu *"You were already told this once and repeated it. Do not produce that output again. If you genuinely cannot act, say exactly {"text": "<reason>"} and nothing else."*
- Cơ chế chống lặp đã có sẵn và nên nói ra là có: `best` scoring giữ attempt tốt nhất. Giữ nguyên.
- **Rủi ro:** rất thấp về kỹ thuật. Rủi ro thật: nếu vòng 1–2 thất bại vì lý do *không liên quan* (ví dụ `runModel` ném lỗi), `retryNote` đã được reset về `""` — hãy giữ nguyên logic đó, đừng gộp.

---

### N5 — Đưa ví dụ `input` vào `# AVAILABLE TOOLS` · *giá trị trung bình · chi phí: token tăng theo số tool · rủi ro: phình context*

Anthropic khuyến nghị `input_examples` như **thay thế rẻ hơn `strict: true`** cho cả ba triệu chứng trong bảng chẩn đoán (§4.3). Bridge không dùng được `strict` (§2.2), nên đây là đường thay thế đúng — **có điều kiện**: nó chỉ có tác dụng *nếu upstream đã hỗ trợ*, và Anthropic tự ghi giá *"~20–50 tokens cho ví dụ đơn giản, ~100–200 tokens cho object lồng nhau"* trên **mỗi tool**. Với 23 tool của Claude Code đó là hàng nghìn token mỗi lượt, không có prompt caching.

Vì vậy: **chỉ thêm ví dụ cho tool mà lịch sử log cho thấy hay sai** (`rejected.badInput` / `rejected.unknownName` trong `bridge.log` đã ghi sẵn). Tối đa 2–3 tool. Đây là một khuyến nghị *có điều kiện*, không phải mặc định.

---

### N6 — Khi `tool_choice: any` và model chỉ trả văn xuôi, mang nội dung model vào thông báo lỗi · *chi phí ~0 · rủi ro: rất thấp*

Hiện tại, nếu hết `MAX_ATTEMPTS` mà `tool_choice: {type:"any"}` vẫn không có tool, `handleMessages` rơi xuống `nothingUsable` → `EmptyTurn` với message **không chứa gì model đã nói**. Người dùng thấy `400 / model returned no usable reply after 3 attempt(s)` và không có cách nào hiểu vì sao.

- Giữ nguyên hành vi 400 (đúng: `tool_choice: any` không được phép kết thúc bằng `end_turn` — khớp với prefill của Anthropic, §4.1).
- Nhưng nhét `rawText` đã bị loại vào `EmptyTurn` (đã có sẵn biến `discarded`, chỉ đang không gửi đi; cần cắt bớt và **không** gửi nguyên văn nếu nó chứa nội dung file — cùng ràng buộc mà comment hiện tại đã áp cho log).
- **Rủi ro:** rất thấp. Đây là thay đổi chẩn đoán, không phải hành vi.

---

### N7 — Log **đường đi của bộ phân tích** · *chi phí ~0 · giá trị: điều kiện tiên quyết cho N1–N5*

`extractJson` hiện trả object hoặc `null` — không cho biết nó thắng bằng cách nào. Thêm bộ chỉ số đã đo được: `parse_path: strict | fence | span | repair | none`.

`bridge.log` đã có `attempts`, `discarded_chars`, `rejected.{unknownName,badInput,badShape}` — đủ để đo tần suất từng lớp lỗi. Không có gì đo được thì mọi thay đổi ở N1–N5 chỉ là niềm tin.

Đây là mục **nên làm trước N1**.

---

### N8 — Constrained decoding: **chưa dùng được; điều kiện để mở ở §2.3** · *giá trị nếu mở: rất lớn · chi phí nếu chưa mở: 0*

Không sửa gì bây giờ. Ba việc để giữ đường mở:

1. **N0** theo dõi API surface.
2. Nếu C1 mở nhưng C2 chưa (vẫn phải đi qua `opencode serve` với credential không lấy được) ⇒ vẫn không dùng được. Đừng đầu tư giữa chừng.
3. Nếu một ngày nào đó có thể gọi provider trực tiếp: cần một bước **`downgradeSchema()`** theo đúng thuật toán Anthropic công bố (gỡ constraint không hỗ trợ → nhét constraint vào `description` → `additionalProperties: false` cho mọi object → lọc `format`). Bridge sẽ cần viết hàm này **dù chưa dùng**, vì nó cũng là cách rẻ nhất để *kiểm tra* schema của Claude Code có nằm trong subset không — và nếu có tool nào không nằm trong subset, strict tool use trên tool đó sẽ bị 400.

**Một đường khác đáng cân nhắc nếu tương lai có decoding:** XGrammar **structural tag** cho phép ràng buộc chỉ vùng tool call và để vùng prose tự do ([`structural_tag/tool_calling_and_reasoning`](https://xgrammar.mlc.ai/docs/latest/structural_tag/tool_calling_and_reasoning.html)). Đó là hình thái đúng cho bridge: vốn cần `text` *và* `tools` cùng tồn tại. Bridge hiện phải chọn giữa "text thuần" và "JSON thuần" — structural tag sẽ bỏ được cái đánh đổi đó. **UNVERIFIED**: tôi chưa đọc kỹ trang structural-tag, chỉ xác nhận API tồn tại qua mục lục docs XGrammar.

---

### Không nên làm

| Ý tưởng | Vì sao không |
| --- | --- |
| **Dùng LLM judge để hỏi model "bạn đã gọi tool chưa?"** | AUROC ≤ 0.65 trên 5 judge × 5 prompt (arXiv 2606.09863). Bridge hiện không làm vậy — đừng thêm. |
| **Thay `extractJson` bằng `jsonrepair`** | Đo được: `jsonrepair` thua 2/14, toàn là lớp prose. `extractJson` hiện nhanh hơn (0.4 ms vs 3.5 ms trên 24 KB) và xử lý đúng lớp lỗi mà repair không biết. |
| **Chuyển sang `json5`** | Loại 3/9 lớp lỗi cú pháp so với `jsonrepair`; không bỏ được fence; không bảo trì từ 2023-03-04. |
| **Dùng Outlines / XGrammar / llguidance / jsonformer trong bridge** | Cả bốn đều là **grammar-constrained decoding hoặc wrapper HuggingFace** — cần truy cập logits/tokenizer hoặc HF model trực tiếp. Bridge chỉ có một `POST` trả về `{text}`. **Không dùng được ở bất kỳ tầng nào.** (Ngoài ra `outlines` trên npm là dự án khác.) |
| **Raw-string-match trên `input` đã serialize** | Anthropic cảnh báo rõ: escape khác nhau giữa các version model làm hỏng so khớp. Bridge hiện chỉ so *tên tool*, không so input — đúng. Giữ nguyên. |
| **Thêm text sau `tool_result`** | Anthropic: *"Never add text blocks immediately after tool results: This teaches Claude to expect user input after every tool use."* `buildTranscript` đang đúng; đừng sửa. |
| **Retry bằng cách gửi lại response rỗng** | Anthropic: không có tác dụng. Bridge cũng không làm vì `/generate` stateless. |

---

## 9. Danh sách nguồn

**Tài liệu chính thức**

- Anthropic — Tool use with Claude: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview>
- Anthropic — Define tools: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools>
- Anthropic — Handle tool calls: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls>
- Anthropic — Strict tool use: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use>
- Anthropic — Structured outputs: <https://platform.claude.com/docs/en/build-with-claude/structured-outputs>
- Anthropic — Stop reasons and fallback: <https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons>
- Anthropic — Troubleshooting tool use: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/troubleshooting-tool-use>
- Anthropic — Manage tool context: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context>
- OpenAI — Structured model outputs: <https://platform.openai.com/docs/guides/structured-outputs>
- vLLM — Structured Outputs: <https://docs.vllm.ai/en/latest/features/structured_outputs/>
- XGrammar docs (0.2.8): <https://xgrammar.mlc.ai/docs/latest/> · engine integration: `…/using_xgrammar/engine_integration.html`
- Outlines docs: <https://dottxt-ai.github.io/outlines/latest/>
- OpenCode — Server: <https://opencode.ai/docs/server/>

**Mã nguồn / registry**

- llguidance: <https://github.com/guidance-ai/llguidance>
- jsonformer: <https://github.com/1rgs/jsonformer>
- jsonrepair: <https://www.npmjs.com/package/jsonrepair> · <https://github.com/josdejong/jsonrepair>
- json_repair (PyPI): <https://pypi.org/project/json-repair/>
- best-effort-json-parser: <https://www.npmjs.com/package/best-effort-json-parser>
- json5: <https://www.npmjs.com/package/json5>
- jsonc-parser: <https://www.npmjs.com/package/jsonc-parser>

**Benchmark**

- BFCL leaderboard (V4, cập nhật 2026-04-12): <https://gorilla.cs.berkeley.edu/leaderboard.html>
- BFCL V4 • Format Sensitivity (blog 17): <https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html>
- BFCL V3 • Multi-Turn (blog 13): <https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html>
- BFCL paper, ICML 2025: trích trong leaderboard page.

**Papers**

- τ-bench: <https://arxiv.org/abs/2406.12045>
- Fission-GRPO (ACL 2026 Main): <https://arxiv.org/abs/2601.15625>
- Structured Reflection for Reliable Tool Interactions (ACL): <https://arxiv.org/abs/2509.18847>
- False Success in LLM Agents (FAGEN@ICML2026): <https://arxiv.org/abs/2606.09863>
- When Do Prompt-Side Agent Playbooks Transfer?: <https://arxiv.org/abs/2608.05778>
- Keyword Harnesses Fail Open (preprint, trọng số thấp): <https://arxiv.org/abs/2610.02142>

**Đo trên máy này**

- `opencode --version` → v2.0.29
- `GET http://127.0.0.1:4599/openapi.json` → spec 276 535 ký tự (đọc một lần, lưu tạm ở `%TEMP%\oc-spec.json`)
- `…\Temp\opencode\jsonrepair-probe\probe{,2,3,4}.mjs` — chỉ `import` read-only từ `bridge.mjs`

---

## 10. Những chỗ tôi không biết

Ghi lại rõ để không ai hiểu nhầm là đã kiểm chứng:

1. **Tần suất thực** của 5 kiểu thất bại trên `space-bunny-free` chưa đo. Mọi phép đo trong file này là trên *input hình dạng lỗi*, không phải trên lưu lượng thật. Cần parse `bridge.log` (`kind:"done"`, `rejected`, `attempts`, `kind:"empty"`, `kind:"narrated"`) trước khi gọi bất kỳ mục N1–N5 nào là "đáng".
2. **Không có số liệu công khai** cho hiệu quả của một lời sửa dạng văn bản thuần trên model nhỏ *không có* lịch sử hội thoại. Các benchmark đo thì có cấp agent loop. N4 là *suy luận từ* hai paper nói về lặp lại lỗi, không phải đo trực tiếp.
3. **Chưa biết** có tồn tại hay không một tài liệu Anthropic/OpenAI nào khuyến nghị trực tiếp "không được mô tả hành động thay vì thực hiện" cho mô hình *không có* tool channel. Tôi đọc `overview`, `define-tools`, `handle-tool-calls`, `troubleshooting-tool-use`, `handling-stop-reasons` và không tìm thấy. Điều tương đương gần nhất là câu của BFCL V1 (*"You SHOULD NOT include any other text in the response"*) — và đó là benchmark, không phải vendor.
4. **Chưa đọc toàn văn** các paper 2509.18847, 2601.15625, 2606.09863, 2608.05778, 2610.02142 — chỉ abstract lấy từ arXiv API. Số liệu trích nguyên văn từ abstract.
5. **Chưa đọc kỹ** trang XGrammar về structural tag; chỉ xác nhận API tồn tại qua mục lục. Xem ghi chú UNVERIFIED ở N8.
6. **Docs OpenCode có mâu thuẫn với binary v2.0.29** về route message (`tools?`). Chưa xác định docs mô tả version nào. Đây là lý do N0 tồn tại.
7. **`space-bunny-free` là model nền tảng nào**: không xác minh được, và cũng không cần — toàn bộ nghiên cứu này độc lập với điều đó.
