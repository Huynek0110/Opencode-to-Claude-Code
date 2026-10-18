# Nghiên cứu: tool calling / streaming của Anthropic Messages API so với `bridge.mjs`

Ngày: 2026-10-17 · Repo: `claude-code-bridge` · Chỉ đọc, không sửa file nào trong repo.

---

## 0. Phương pháp và mức độ tin cậy

### Nguồn dùng

| # | Nguồn | Loại | URL / đường dẫn |
|---|---|---|---|
| S1 | Anthropic Messages API reference | tài liệu chính thức | `https://platform.claude.com/docs/en/api/messages` |
| S2 | Streaming messages | tài liệu chính thức | `https://platform.claude.com/docs/en/build-with-claude/streaming` |
| S3 | Stop reasons and fallback | tài liệu chính thức | `https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons` |
| S4 | Claude API errors | tài liệu chính thức | `https://platform.claude.com/docs/en/api/errors` |
| S5 | Define tools (tool_choice) | tài liệu chính thức | `https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools` |
| S6 | Handle tool calls (tool_result) | tài liệu chính thức | `https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls` |
| S7 | Parallel tool use | tài liệu chính thức | `https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use` |
| S8 | Effort | tài liệu chính thức | `https://platform.claude.com/docs/en/build-with-claude/effort` |
| S9 | Mã nguồn `@anthropic-ai/sdk` (client) | mã nguồn chính thức | `https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@latest/client.js` |
| S10 | `sdk-tools.d.ts` của `@anthropic-ai/claude-code` (bản cài trên máy này) | artifact chính thức của Anthropic | `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\sdk-tools.d.ts` |
| S11 | Binary `claude.exe` của `@anthropic-ai/claude-code` — đọc chuỗi để tìm logic retry, SSE accumulation, stop_reason mapping, nhận diện context-overflow | mã nguồn chính thức (đóng gói) | `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` |
| S12 | Zod 4 `z.toJSONSchema()` | tài liệu thư viện (Claude Code dùng Zod 4) | `https://zod.dev/json-schema` |
| S13 | `bridge.log` của chính repo | đo thực nghiệm (không phải tài liệu) | `bridge.log` trong repo |

Lưu ý về URL: `docs.anthropic.com` hiện redirect sang `platform.claude.com` — cùng nội dung.

### Chú giải mức độ chắc chắn

- **CAUGHT UP** — có bằng chứng trực tiếp từ nguồn gốc nêu trên (tài liệu Anthropic, mã nguồn SDK chính thức, hoặc artifact do Anthropic phát hành).
- **INFERRED** — suy luận từ nguồn gốc + hành vi quan sát được; không có câu nào trong tài liệu nói thẳng.
- **UNVERIFIED** — không tìm được nguồn. Đã ghi rõ ảnh hưởng tới thiết kế.

### Một giới hạn cần nói thẳng trước

Tôi **không** capture được một request thật của Claude Code (không chạy `claude` vì sẽ ghi file ngoài repo). Với câu 1, tôi dựa vào `sdk-tools.d.ts` + logic trong `claude.exe`. Đó là nguồn chính thức của Anthropic, nhưng nó là **type surface của Agent SDK**, không phải bản JSON `input_schema` byte-for-byte mà CLI gửi đi. Mọi nơi tôi rút ra `required` từ đó đều đánh dấu **INFERRED**.

---

## 1. Bộ tool mặc định của Claude Code và `input_schema`

### 1.1 Claude Code dựng `input_schema` thế nào

Trong `claude.exe` (S11) có hai dòng quyết định:

```js
// serializer / tool-types builder
inputSchema: n.inputJSONSchema ?? nD(n.inputSchema)
```

```js
// API request builder
oo = { name: e.name, description: Ko.description, input_schema: qo }
```

Tức là:

- Tool **MCP** có `inputJSONSchema` (do server `tools/list` khai báo) → gửi nguyên văn.
- Tool **native của Claude Code** chỉ có zod `inputSchema` → gửi `nD(zodSchema)` — tức **`z.toJSONSchema()` của Zod 4** (binary có đủ Zod 4 + `toJSONSchema`).

Hệ quả quyết định (S12, mục *Object schemas*):

> "By default, `z.object()` schemas contain `additionalProperties: false`. This is an accurate representation of Zod's default behavior, as plain `z.object()` schema **strip** additional properties."
>
> "When converting to JSON Schema in `"input"` mode, `additionalProperties` is not set."

Claude Code gọi `toJSONSchema` không truyền option ⇒ dùng `io` mặc định (`"output"`) ⇒ **mọi object ở mọi cấp đều có `additionalProperties: false`**.

Điều này **xác nhận** điều README của repo đo được (validator reject `workdir`), và cho biết cơ chế: `additionalProperties: false` là hệ quả tất định của Zod-4-output-mode, không phải chuyện ngẫu nhiên.

> **Mức: CAUGHT UP** (logic trong S11 + hành vi ghi trong S12).
> Ngoại lệ duy nhất: nếu Claude Code truyền `io:"input"` thì `additionalProperties` biến mất. Tôi không tìm thấy bằng chứng nó làm vậy — binary có `unrepresentable:"any"` được dùng ở ít nhất một chỗ, nhưng không thấy `io` được đặt cho tool schema. Xem `clampLevel` bên dưới.

### 1.2 Hình dạng input của từng tool (từ S10)

`required` suy ra bằng quy tắc: khóa không `.optional()` trong Zod ⇒ nằm trong `required`.

| Tool (tên CLI) | Type trong S10 | `required` | `optional` |
|---|---|---|---|
| `Read` | `FileReadInput` | `file_path` | `offset` (int ≥0), `limit` (int >0), `pages` (string), `allow_large` (bool) |
| `Write` | `FileWriteInput` | `file_path`, `content` | — |
| `Edit` | `FileEditInput` | `file_path`, `old_string`, `new_string` | `replace_all` (bool) |
| `Bash` | `BashInput` | `command` | `timeout`, `description`, `run_in_background`, `dangerouslyDisableSandbox` |
| `Grep` | `GrepInput` | `pattern` | `path`, `glob`, `output_mode`, `-B`, `-A`, `-C`, `context`, `-n`, `-i`, `-o`, `type`, `head_limit`, `offset`, `multiline` |
| `Glob` | `GlobInput` | `pattern` | `path` |
| `TodoWrite` | `TodoWriteInput` | `todos` | — (`todos[]` = `{content, status, activeForm}` — **cả 3 đều required**) |
| `NotebookEdit` | `NotebookEditInput` | `notebook_path`, `new_source` | `cell_id`, `cell_type`, `edit_mode` |
| `WebFetch` | `WebFetchInput` | `url`, `prompt` | `offset` |
| `WebSearch` | `WebSearchInput` | `query` | `allowed_domains`, `blocked_domains` |
| `Task` | `AgentInput` | `description`, `prompt` | `subagent_type`, `model`, `effort`, `run_in_background`, `name`, `team_name`, `mode`, `isolation` |

**`Bash` không có `workdir`, không có `cwd`, không có `shell`** → xác nhận tuyệt đối README đúng ở chỗ này. Đây là nguồn gốc, không còn là đoán.

### 1.3 Tên tool: cái nào có thật, cái nào bịa

Đếm chuỗi trong `claude.exe` (S11) và đọc các bảng hằng số:

- `vze.filePatternTools = ["Read","Write","Edit","Glob","NotebookRead","NotebookEdit","Cd"]`
- `vze.bashPrefixTools = ["Bash"]`
- `["Edit","Write","NotebookEdit"]` (nhóm tool có thêm file vào turn)
- `new Set([...filePatternTools, <một hằng>, "MultiEdit", "LS"])`
- một danh sách nhóm-permission chứa `"NotebookRead"`, `"LS"`
- có mặt: `TaskOutput`, `TaskStop`, `KillBash`, `KillShell`, `ExitPlanMode`, `AskUserQuestion`, `Skill`, `SlashCommand`, `EnterPlanMode`, `TaskCreate/TaskGet/TaskList/TaskUpdate`, `Workflow`, `CronCreate`, `Artifact`, `Monitor`, `SendMessage`, `ScheduleWakeup`, `RemoteTrigger`, `Projects`, `ClaudeDesign`, `ListMcpResources`, `ReadMcpResource(Dir)`, `RefreshMcpTools`, `ReportFindings`, `EnterWorktree`, `ExitWorktree`
- **không có**: `TodoRead` (0 lần xuất hiện), `TaskDelete` (0 lần)

⇒ `LS` và `NotebookRead` **là tên tool thật**. `TodoRead` **không tồn tại** trong bản Claude Code trên máy này.

Tên tool được minify thành hằng số (`Qe`, `Pr`, `dt`…), nên tôi **không** dựng lại được danh sách 23 tool mà Claude Code gửi trong một turn cụ thể. Repo đo được `tools: 23` (`bridge.log`). **Mức: UNVERIFIED** cho danh sách đầy đủ 23 tool — nhưng không quan trọng, vì bridge chỉ cần biết tool nào **thực sự tồn tại** (để alias) và tool nào không (để bỏ).

### 1.4 Bridge map sai ở đâu

| # | Vấn đề | Mức | Vì sao |
|---|---|---|---|
| 1.1 | **`Glob` không có key remap.** OpenCode quảng bá `include`; `Glob` của Claude Code **required `pattern`**. Model gửi `include` ⇒ thiếu `pattern` ⇒ schema violation **mỗi lần gọi Glob**. | CAUGHT UP (S10 + S12) | `INPUT_KEY_MAP` chỉ map `include → glob` cho `Grep`, không có entry cho `Glob` |
| 1.2 | **`additionalProperties: false` ở *mọi* object.** `DROP_INPUT_KEYS` chỉ bịt 3 khoá trên `Bash`. Bất kỳ khoá dư nào model bịa ra, hoặc mượn từ schema rộng hơn của OpenCode, đều là lỗi cứng nuốt cả lượt. | CAUGHT UP | Xem §11 / hệ quả P0 |
| 1.3 | **`Edit`: `replaceAll` chưa map sang `replace_all`.** | CAUGHT UP (S10) | `INPUT_KEY_MAP.Edit` thiếu |
| 1.4 | **`todoread: ["TodoRead"]` là alias chết** — không có tool `TodoRead`. | CAUGHT UP | 0 lần xuất hiện trong `claude.exe` |
| 1.5 | `patch`, `webfetch` cố ý không alias | **đúng** | `Edit` cần `old_string`/`new_string`, `WebFetch` cần `prompt` — không map được |
| 1.6 | `subagent` cố ý không alias | **đúng** (giữ nguyên) | `Task` mặc định chạy nền; alias sẽ kích hoạt agent thật |
| 1.7 | Schema của `LS`, `NotebookRead`, `Skill` | **UNVERIFIED** | Không có trong `sdk-tools.d.ts`. `LS`/`NotebookRead` chắc chắn là tool thật nhưng hình dạng input thì không. `Skill` thậm chí không xuất hiện trong danh sách nhóm nào tôi tìm được. |
| 1.8 | `Task`: bridge không map khoá nào | UNVERIFIED | Không biết `task` của OpenCode quảng bá đúng khoá nào. Nếu là `description`/`prompt`/`subagent_type` thì khớp; nếu có `agent`/`type` thì hỏng. |

### 1.5 Những cấu trúc JSON-Schema mà `validateInput` chưa xử lý

Zod 4 sinh ra các từ khoá mà `validateInput()` hiện bỏ qua:

- `exclusiveMinimum` / `exclusiveMaximum` / `minimum` / `maximum` — ví dụ `Read.limit` là `int().positive()` ⇒ Zod phát `{type:"integer", exclusiveMinimum:0}`. Model gửi `limit: 0` sẽ lọt qua bridge rồi bị Claude Code từ chối.
- `minItems` / `maxItems` — `AskUserQuestion.questions` có `minItems:1, maxItems:4`; `TodoWrite` không có nhưng các tool khác có.
- `anyOf` lồng nhau trong `items` — bridge xử lý `anyOf/oneOf` nhưng chỉ ở cấp đang validate.
- `const` — bridge không xử lý.
- `description` không có tác dụng gì cho validation.

Không cái nào là sai lệch contract, nhưng tất cả đều là cơ hội bắt lỗi **sớm hơn** (tiết kiệm một lượt retry) thay vì để Claude Code từ chối.

---

## 2. `stop_reason`

### 2.1 Tập giá trị hợp lệ

| Nguồn | Danh sách |
|---|---|
| S1 (Messages API schema) | `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal` |
| S3 (Stop reasons) | 7 giá trị trên **+** `model_context_window_exceeded` |
| S11 — zod `Message` của SDK | `"end_turn, max_tokens, stop_sequence, tool_use, pause_turn, refusal, ...; null while the message is still streaming."` |
| S11 — hằng `T0r` của Claude Code | `["end_turn","max_tokens","stop_sequence","tool_use","pause_turn","compaction","refusal","model_context_window_exceeded"]` |

⇒ Tập chuẩn: **6 giá trị** trong type công khai; `model_context_window_exceeded` có trong tài liệu; `compaction` là giá trị riêng của Claude Code.

**CAUGHT UP.**

### 2.2 Khi nào cái nào

| Giá trị | Khi nào | Mức |
|---|---|---|
| `end_turn` | Model tự kết thúc lượt. Cũng xảy ra khi model trả về **response rỗng** (2–3 token, `content: []`) — S3 gọi đây là hành vi đã biết, và cảnh báo **đừng thêm text ngay sau `tool_result`**. | CAUGHT UP |
| `max_tokens` | Chạm `max_tokens` của request, **hoặc** trần tối đa của model. S3 nói rõ: response bị cắt có thể chứa **tool_use block không hoàn chỉnh**. | CAUGHT UP |
| `stop_sequence` | Model phát ra một phần tử của `stop_sequences` bạn gửi; `stop_sequence` trả về chuỗi khớp. | CAUGHT UP |
| `tool_use` | Model gọi một hoặc nhiều tool. | CAUGHT UP |
| `pause_turn` | Vòng lặp **server tool** chạm giới hạn vòng lặp. Gửi lại nội dung assistant để tiếp tục. | CAUGHT UP |
| `refusal` | Classifier chặn; đọc `stop_details`. | CAUGHT UP |
| `model_context_window_exceeded` | Response lấp đầy context window của model → coi như đã cắt. | CAUGHT UP (chỉ có ở S3) |
| `compaction` | Claude Code-side. | CAUGHT UP (chỉ ở S11) |

### 2.3 `tool_use` vs `max_tokens` khi cả hai xảy ra — câu bạn hỏi đúng chỗ

**Anthropic không document thứ tự ưu tiên.** Tôi đọc S2, S3, S1 — không có câu nào nói "khi cả hai, ưu tiên cái nào". **Mức cho phần "Anthropic nói gì": UNVERIFIED — họ không nói gì cả.**

Nhưng có thể trả lời bằng hành vi thật của client, và đây mới là điều quyết định thiết kế. Trong `claude.exe` (S11):

```js
function Id(e) {                       // stop_reason -> hành động tiếp theo
  if (e === null) return "stop";
  switch (e) {
    case "tool_use":                                  return "run_tools";
    case "pause_turn": case "compaction":              return "resume";
    case "end_turn": case "stop_sequence":
    case "max_tokens": case "model_context_window_exceeded":
    case "refusal":                                   return "stop";
    default: return "stop";
  }
}
```

Khi `max_tokens`, Claude Code **không chạy tool**. Nó coi turn là kết thúc.

⇒ **Ưu tiên `max_tokens` là đúng**, và giờ đây có cơ sở nguồn gốc thay vì suy đoán:

```js
// bridge.mjs:1663 — giữ nguyên
const stopReason = truncated ? "max_tokens" : hasTool ? "tool_use" : "end_turn";
```

Comment trong `bridge.mjs` viết "nếu budget hết thì turn thật sự đã bị cắt, báo `tool_use` sẽ nói dối client rằng nó có một tool call hoàn chỉnh để chạy" — chính xác. Chỉ cần bổ sung: **Claude Code sẽ bỏ qua `tool_use` khi `stop_reason` là `max_tokens`**, tức là hành vi "báo tool_use" sẽ khiến nó **chạy một tool call bị cắt cụt**. Đó là lý do mạnh hơn lập luận hiện tại.

**`max_tokens` có được trả về cùng `tool_use` không?** Có — S3 (accordion *Incomplete tool use blocks*) mô tả đúng tình huống: response bị cắt chứa một tool_use block không hoàn chỉnh, và `stop_reason` trong ví dụ kiểm tra là `max_tokens`. **CAUGHT UP.**

**`stop_sequence`:** bridge luôn trả `stop_sequence: null` và **bỏ qua `body.stop_sequences` hoàn toàn**. Nếu Claude Code từng gửi `stop_sequences`, bridge sẽ âm thầm không làm gì. Đây là một khoảng trống thật (xem hệ quả P2).

---

## 3. Streaming + `tool_use`

### 3.1 Chuỗi event chính xác (trích nguyên văn S2)

Text **và** tool_use trong cùng một turn:

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_014p…","type":"message","role":"assistant",
      "model":"claude-opus-5","stop_sequence":null,
      "usage":{"input_tokens":472,"output_tokens":2},"content":[],"stop_reason":null}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Okay"}}
… nhiều delta …

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,
       "content_block":{"type":"tool_use","id":"toolu_01T1…","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}}
event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}
event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \"San"}}
…
event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" CA\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":89}}

event: message_stop
data: {"type":"message_stop"}
```

### 3.2 `content_block_start` với `input = {}` — đúng không?

**Đúng.** Ví dụ chính thức S2 dùng đúng `"input":{}`. Bridge `emitBlocks()` làm đúng.

### 3.3 `partial_json` phải là gì

- S2: *"the deltas are **partial JSON strings**, whereas the final `tool_use.input` is always an **object**"* và *"You can accumulate the string deltas and parse the JSON once you receive a `content_block_stop` event"*.
- Cơ chế ghép trong SDK (S11): `let y = (h[Yt] || "") + n.delta.partial_json` — **nối chuỗi**.

⇒ **Nối tất cả `partial_json` phải ra JSON object của toàn bộ input.** Gửi **một** delta duy nhất chứa toàn bộ JSON là hợp lệ (Anthropic tách nhỏ vì độ trễ, không phải vì bắt buộc).

Bridge hiện tại:
```js
json = JSON.stringify(block.input);
delta = { type: "input_json_delta", partial_json: json };
```
**Đúng.** Một khác biệt nhỏ: Anthropic gửi `partial_json: ""` trước. Không bắt buộc.

### 3.4 Claude Code có validate JSON đó không? — **CÓ**

S11, xử lý `content_block_stop` của tool_use:

```js
let y;
try { y = h.input }
catch (w) { /* Ia(): */ }
…
Ia = (n, s) => new Zn(
  `Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt. Error: ${s}. JSON: ${h}`)
```

Nếu chuỗi `partial_json` cộng lại không parse được, **cả lượt chết** với message đó. Bridge đã có fallback `json = "{}"` khi `JSON.stringify` throw — đúng, giữ nguyên.

Claude Code còn validate thêm (tên event trong bảng telemetry của S11):

`message_start_without_message` · `content_block_start_without_content_block` · `content_block_closed_start` · `content_block_closed_delta` · `content_block_not_found_delta` · `content_block_delta_without_delta` · `content_block_delta_without_delta_type` · `content_block_type_mismatch_input_json` · `content_block_input_not_string` · `input_json_delta_without_partial_json` · `content_block_type_mismatch_text` · `text_delta_without_text` · `content_block_closed_stop` · `content_block_not_found_stop` · `partial_message_not_found` · `message_delta_without_delta`

Và một kiểm tra rõ ràng về `index`:
```js
function bs(e) { let t = typeof e.index === "number" && e.index >= 0; … }
```

Trong accumulator, `content_block_start` **push** vào `content[]` (bỏ qua `index`), còn `content_block_delta`/`_stop` **index theo `n.index`**. ⇒ `index` phải là vị trí 0-based trong mảng content. Index không liên tục ⇒ delta rơi vào `undefined` ⇒ **input tool âm thầm thành `{}`**. Bridge `idx = 0,1,2…` là đúng. **CAUGHT UP.**

Ngoài ra S11 còn phát hiện:
- `Stream ended cleanly inside open block …` — block không được đóng.
- `Stream completed with message_start but no content blocks completed - triggering non-streaming fallback` — không có block nào đóng trọn vẹn.

Bridge đóng mọi block bằng `content_block_stop`. **Đúng.**

### 3.5 `ping` và lỗi giữa chừng

- S2: *"Event streams may also include any number of `ping` events"* — **ở bất kỳ đâu**, kể cả giữa `message_start` và `content_block_start`. Nên quyết định của bridge (dùng **SSE comment** `: keep-alive` thay vì `event: ping`) là hợp lệ và thậm chí an toàn hơn. Comment SSE bị mọi parser SSE bỏ qua theo chuẩn. Ghi chú README nói "đã từng phát `event: ping` trước `message_start`" — đó **không vi phạm tài liệu**; chỉ là thay đổi đó không cần thiết.
- Lỗi giữa chừng: S2 cho ví dụ `event: error` + `{"type":"error","error":{…}}`. Tài liệu không nói rõ có `message_stop` hay không, nhưng một stream kết thúc bằng `error` thì không có `message_stop`. Bridge làm vậy. **Đúng / INFERRED** (tài liệu không phủ định tường minh).

---

## 4. Nhiều `tool_use` trong một assistant turn

- **Hợp lệ, và là mặc định.** S7: *"By default, Claude may call multiple tools in a single response."* Claude 4+ gọi song song theo mặc định.
- **Tắt:** `disable_parallel_tool_use: true` **bên trong object `tool_choice`**, không phải tham số top-level (S7 nói rõ: *"It is not a top-level request parameter"*). Tác dụng tuỳ `tool_choice.type`: `auto` ⇒ **tối đa** 1; `any`/`tool` ⇒ **đúng** 1.
- **Thứ tự thực thi là quyết định của client** — API không áp đặt (S7).
- **Phải trả về đúng một `tool_result` cho mỗi `tool_use`, tất cả trong *một* user message, `tool_result` đứng trước mọi text.** S6 + S7. Nếu chạy tuần tự mà một call trước fail, vẫn phải trả `tool_result` cho call đó với `is_error: true`.
- **Sai lầm dễ mắc:** tách mỗi `tool_result` ra một user message riêng ⇒ *teaches Claude to avoid parallel calls* (S7, mục Troubleshooting).

**Bridge:**
- `content` chứa nhiều block `tool_use` với `index` tuần tự → hợp lệ. **Đúng.**
- **Thiếu:** bridge **bỏ qua hoàn toàn `disable_parallel_tool_use`**. Một request `{type:"auto", disable_parallel_tool_use:true}` có thể nhận về 3 `tool_use`; Claude Code sẽ chạy cả 3 → vi phạm contract mà chính client đặt ra.
- **Lệch nhỏ về thứ tự:** bridge xếp `tool_use` **trước**, `text` **sau**. Anthropic ví dụ (S6) và hành vi thật đặt `text` **trước** `tool_use`. Tôi không tìm thấy kiểm tra thứ tự nào ở phía assistant trong Claude Code hay trong docs ⇒ **không sai contract**, nhưng làm lệch hình dạng chuẩn.

---

## 5. `tool_result`

### 5.1 `tool_use_id`

- Bắt buộc, phải khớp `id` của block `tool_use`. Pattern: **`^[a-zA-Z0-9_-]+$`** (S1).
- Nếu thiếu/sai: S6 ghi rõ lỗi *"tool_use ids were found without tool_result blocks immediately after"*.
- Bridge: `newId("toolu")` ⇒ `toolu_` + base36 timestamp + counter + random base36 ⇒ toàn bộ `[a-z0-9_]` ⇒ khớp pattern. **Đúng.**
- `id` của `tool_use` **phải unique** trong transcript (Claude Code có detector `duplicate_tool_use_id`). Bridge tạo id mới mỗi lượt. **Đúng.**

### 5.2 `is_error`

- Optional boolean. Đặt `true` khi tool **thực sự** lỗi trong lúc chạy (S6).
- Có ba lớp lỗi S6 phân biệt: lỗi thực thi tool → `is_error: true`; **tool call không hợp lệ (thiếu tham số)** → *vẫn* nên trả `tool_result` + `is_error: true` để Claude tự sửa và thử lại; lỗi **server tool** → không cần `is_error`.
- Claude Code tự bọc nội dung lỗi trong `<tool_use_error>…</tool_use_error>` khi đọc `is_error` (S11, chuỗi `<tool_use_error>InputValidationError: …`).
- Bridge: `is_error: !!block.is_error` và render ` error` trong thẻ `<tool_result … error>` ⇒ model vẫn biết. **Chấp nhận được.**

### 5.3 `content` chứa được gì

Theo S1, `content` là **string** hoặc mảng các loại block sau — và **không có `tool_use`, không có `tool_result`**:

`TextBlockParam` · `ImageBlockParam` · `SearchResultBlockParam` · `DocumentBlockParam` · `ToolReferenceBlockParam` · `BrowserStateBlockParam`

⇒ **Không được chứa block lồng nhau kiểu tool.** Câu hỏi của bạn trả lời: **không** — không có `tool_use`/`tool_result` lồng nhau.

Bridge `flattenContent()` render mọi thứ thành text và kèm nhãn `[tool_use] {...}` / `[image omitted]` cho loại không render được được. Với vai trò "đưa cho model đọc", đó là phép chiếu hợp lý; không có gì sai về mặt contract vì bridge không gửi `tool_result` đi đâu — nó chỉ **nhận**.

### 5.4 Claude Code gửi lại thế nào

Đây là điều API ràng buộc, nên nó ràng buộc cả phía nhận của bridge:

1. `tool_result` phải **ngay sau** message chứa `tool_use` tương ứng. Không được chen message nào vào giữa. (S6)
2. Trong user message chứa kết quả, **`tool_result` phải đứng đầu**, text sau tất cả. (S6 — "This is correct when the assistant turn calls only client tools" / "Text before tool_result" ⇒ 400.)
3. Nếu assistant turn gọi cả client tool lẫn **server tool** chưa có result, user message phải **chỉ** chứa `tool_result`. (S6, S3)
4. **Không thêm text ngay sau `tool_result`** — đây là nguyên nhân #1 gây **response rỗng `end_turn`** (S3, accordion *Empty responses with end_turn*).

Bridge `buildTranscript()` giữ nguyên thứ tự block user ⇒ tôn trọng (2). `midToolLoop` dùng `every(b => b.type === "tool_result")` nên **nhạy với (4)**: nếu Claude Code từng chèn một text block sau kết quả (ví dụ reminder), `midToolLoop` thành `false` và logic `narrated`→`EmptyTurn` không bắn.

---

## 6. `tool_choice`

### 6.1 Giá trị và trường

S1 (định nghĩa kiểu) + S5 (mô tả):

| `type` | Trường | Nghĩa |
|---|---|---|
| `"auto"` | `disable_parallel_tool_use?: boolean` | Claude tự quyết có gọi tool không. **Mặc định khi có `tools`.** |
| `"any"` | `disable_parallel_tool_use?: boolean` | Phải dùng *một trong* các tool, không ép tool cụ thể. |
| `"tool"` | `name: string`, `disable_parallel_tool_use?: boolean` | Ép đúng tool đó. |
| `"none"` | *(không có trường con nào)* | Cấm dùng tool. **Mặc định khi không có `tools`.** |

**Còn trường nào nữa không?** Chỉ `disable_parallel_tool_use`, và nó **chỉ có trên `auto`/`any`/`tool`, không có trên `none`**. Không có tham số top-level. **CAUGHT UP.**

### 6.2 `none` khác `auto` thế nào

- `auto`: tool **được phép** nhưng không bắt buộc — model có thể trả lời văn xuôi.
- `none`: tool **bị cấm** — không được phát `tool_use`.

Về **hành vi quan sát được**, hai cái giống nhau: cả hai đều không được trả `tool_use`. Khác nhau ở chỗ model có bị "nhắc" hay không.

**Bridge xử lý đúng:**
- `mustCallTool()` chỉ ép khi `any`/`tool` ⇒ `auto` không ép. **Đúng.**
- `type: "none"` ⇒ lọc bỏ mọi `tool_use`, và nếu còn trống ⇒ `EmptyTurn` 400. **Đúng** (API thật cũng không bao giờ phát `tool_use` khi `none`).
- `type: "tool"` ⇒ chỉ giữ block khớp `name`, còn lại lọc; nếu không còn block nào ⇒ `EmptyTurn`. **Đúng**, và comment giải thích vì sao check phải nằm **sau** bước lọc là chính xác.

### 6.3 Một điều cần biết (không phải bug của bridge)

S4 + S5: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`, `claude-mythos-5-1` **trả 400** cho `tool_choice` kiểu `any`/`tool`. Bridge quảng bá `behavesAs: "claude-opus-4-7"` (có hỗ trợ forced tool use), nên không vướng. Nhưng nếu đổi `behavesAs` sang dòng mới thì bridge vẫn **chấp nhận** `any`/`tool` trong khi Anthropic thật sẽ 400 — một sự lệch âm thầm.

### 6.4 Ngoài lề: thay đổi `tool_choice` phá cache

S5: *"changes to the `tool_choice` parameter will invalidate cached message blocks"*. Vô hại với bridge (không có caching), nhưng đáng biết.

---

## 7. Retry semantics — điểm độ tin cậy cao

Đây là câu bạn yêu cầu độ tin cậy cao. Nó xác nhận được, và có nguồn sơ cấp.

### 7.1 `x-should-retry` — **CÓ, đúng là header SDK đọc**

Mã nguồn `@anthropic-ai/sdk` (S9), nguyên văn:

```js
// Note this is not a standard header.
const shouldRetryHeader = response.headers.get('x-should-retry');
// If the server explicitly says whether or not to retry, obey.
if (shouldRetryHeader === 'true') return true;
if (shouldRetryHeader === 'false') return false;
// Retry on request timeouts.
if (response.status === 408) return true;
// Retry on lock timeouts.
if (response.status === 409) return true;
// Retry on rate limits.
if (response.status === 429) return true;
// Retry internal errors.
if (response.status >= 500) return true;
return false;
```

Chính SDK tự ghi chú: **"Note this is not a standard header."**

Cùng mã đó xuất hiện trong `claude.exe` (S11) ⇒ Claude Code đọc đúng header này.

**Thứ tự ưu tiên:**
1. `x-should-retry: "true"` → retry
2. `x-should-retry: "false"` → **không retry, kể cả 5xx**
3. 408, 409, 429, ≥500 → retry
4. còn lại (400, 401, 403, 404, 413, 422, …) → **không retry**

**CAUGHT UP** (mã nguồn SDK chính thức + binary Claude Code).

### 7.2 `retry-after` và `retry-after-ms`

Cùng nguồn (S9):

```js
// Note the `retry-after-ms` header may not be standard, but is a good idea
// and we'd like proactive support for it.
const retryAfterMillisHeader = responseHeaders?.get('retry-after-ms');
…
// About the Retry-After header: https://developer.mozilla.org/…/Retry-After
const retryAfterHeader = responseHeaders?.get('retry-after');
if (retryAfterHeader && !timeoutMillis) {
  const timeoutSeconds = parseFloat(retryAfterHeader);
  …
}
// nếu không có / ngoài khoảng hợp lệ -> calculateDefaultRetryTimeoutMillis (exponential backoff)
```

- `retry-after-ms` (mili-giây) được đọc **trước**.
- `retry-after`: `parseFloat` ⇒ coi là **giây**; nếu không parse được thì `Date.parse(...) - Date.now()` (HTTP-date).
- Chỉ dùng giá trị nếu `> 0 && <= 2147483647` ms, nếu không thì rơi về backoff mặc định.
- **CAUGHT UP.**

S4 xác nhận phía server: SDK *"automatically retries transient failures … with exponential backoff, **twice by default**, honoring the `retry-after` header when present"*, và *"A tier spend-cap 429 has **no** `retry-after` header"*.

### 7.3 Lớp retry riêng của Claude Code (S11)

```js
let r = e.headers?.get("x-should-retry");
if (r === "true" && (!Et() || xte() || VEn(e))) return true;
if (r === "false") { return false }        // kể cả khi status >= 500
…
function ae(e) { return e instanceof Mt && e.status === 503 && e.headers?.get("x-should-retry") === "false" }
function SHr(e) { return ae(e) ? b("headerless_decline") : b("headerless_retryable_503") }
```

Claude Code còn **tự đặt** `x-should-retry: false` khi `retry-after` của upstream vượt ngân sách chờ của nó (`ewt`), dùng header nội bộ riêng `x-cc-retry-after-too-long`. Nó cũng có sẵn `retry-after-ms` trong danh sách header "được phép đi lên telemetry".

### 7.4 Đánh giá bridge

| Hành vi bridge | Đúng không |
|---|---|
| `x-should-retry` trên **mọi** lỗi | ✅ đúng |
| `x-should-retry: false` cho 400/413/500-noisy | ✅ đúng — và cần thiết để override "≥500 thì retry" |
| `x-should-retry: true` + `retry-after` cho 5xx/429/503 | ✅ đúng |
| `retry-after: "2"` (chuỗi số) | ✅ SDK `parseFloat("2") * 1000 = 2000ms` |
| `retry-after: "5"` khi 429 | ✅ |
| `EmptyTurn` → 400 + `x-should-retry: false` | ✅ (400 vốn đã non-retryable; header chỉ là chốt) |

**Ghi nhận độ tin cậy: CAUGHT UP.** Đây là câu trả lời chắc nhất trong bài viết này.

> **Điểm mờ duy nhất:** `x-should-retry` **không** xuất hiện trong tài liệu `api/errors` của Anthropic — trang đó chỉ document `retry-after`. Nên: header **có thật và đúng** (theo mã nguồn SDK chính thức + binary Claude Code), nhưng **không được document**. Nếu tương lai Anthropic bỏ nó, bridge mất override nhưng vẫn đúng theo mặc định 408/409/429/5xx.

---

## 8. Context overflow

### 8.1 `ContextWindowExceededError` là gì?

- **Không có trong tài liệu Anthropic.** Đã đọc S4 (`api/errors`) và S3 — không xuất hiện.
- **Không có trong Claude Code.** Đếm chuỗi trong `claude.exe`: **0 lần**.

⇒ Nó **không phải convention của Anthropic**. Tên đó trông như tên lớp lỗi của AWS Bedrock (`ValidationException`/`ThrottlingException` cùng họ với `ModelTimeoutException`), và trong repo nó có dấu vết của việc **đảo ngược suy ra từ hành vi**. README đang khẳng định:

> *"Claude Code chỉ tự compact khi nhận `400` có chuỗi `ContextWindowExceededError`."*

**Sai.** Câu này cần sửa.

### 8.2 Claude Code thật sự nhận diện gì (S11, nguyên văn)

```js
function vEr(e) {
  let n = e.toLowerCase();
  return n.includes("prompt is too long")
      || n.includes("input is too long for requested model");
}
function kEr(e) { return e.toLowerCase().includes("context window") }
function W_o(e) { return e.toLowerCase().includes("input length and `max_tokens` exceed context limit") }
```

Và bộ phân loại:

```js
function CEr(e /*status*/, n /*message*/, r /*betas*/) {
  if (e === 413) return kEr(n) || vEr(n) ? "prompt_too_long" : void 0;
  if (e !== 400) return;
  …
  if (vEr(n)) return "prompt_too_long";
  if (W_o(n)) return "max_tokens_context_overflow";
  …
}
function CD(e) {                                   // trigger auto-compact
  if (!(e instanceof Error)) return !1;
  return vEr(e.message) || fM(e.message, "prompt_too_long");
}
function Q$(e) {
  return e instanceof Error && (W_o(e.message) || fM(e.message, "max_tokens_context_overflow"));
}
```

`fM(x, cap)` kiểm tra marker có cấu trúc `capability_rejected: <cap>`.

**Bảng đầy đủ:**

| Chuỗi trong `message` | Status cần | Kết quả |
|---|---|---|
| `prompt is too long` | bất kỳ | `prompt_too_long` → **auto-compact** |
| `input is too long for requested model` | bất kỳ | `prompt_too_long` → **auto-compact** |
| `context window` | **413** | `prompt_too_long` → auto-compact |
| ``input length and `max_tokens` exceed context limit`` | bất kỳ | `max_tokens_context_overflow` |
| `capability_rejected: prompt_too_long` | bất kỳ | auto-compact |

**CAUGHT UP.**

### 8.3 Bridge có đang hoạt động không?

Message hiện tại trong `ContextTooLong`:

```
prompt is too long: ContextWindowExceededError - prompt token count of N exceeds the limit of M tokens
```

Chứa `prompt is too long` ⇒ **kích hoạt `vEr` ⇒ auto-compact chạy đúng**. Bridge **đang hoạt động, nhưng do trùng tình cờ** với ba chữ "prompt is too long" trong câu tiếng Anh. Nếu ai đó sau này dịch hay rút gọn message, auto-compact chết âm thầm mà không có gì đỏ.

### 8.4 Field chuẩn của Anthropic

Có, S4:

```json
{"type": "error", "error": {"type": "invalid_request_error", "message": "…"}}
```

với HTTP **400** cho lỗi format/nội dung. Bridge dùng đúng shape (`toAnthropicError` → `{status:400, type:"invalid_request_error"}`).

Ngoài ra: **32 MB** là trần request của Messages API, quá là **413 `request_too_large`** (S4). Bridge hiện đọc tới **64 MB**.

---

## 9. `usage` trong streaming

### 9.1 `message_start` có `output_tokens` không?

**Có — và không phải 0.** S2, ví dụ chính thức:

```json
"message_start" … "usage":{"input_tokens":25,"output_tokens":1}
"message_start" … "usage":{"input_tokens":472,"output_tokens":2}
"message_start" … "usage":{"input_tokens":2679,…,"output_tokens":3}
```

**CAUGHT UP.**

### 9.2 `message_delta.usage` mang gì?

S2 ghi rõ: *"The token counts shown in the `usage` field of the `message_delta` event are **cumulative**."*
Trong ví dụ tool-use: `message_start` `output_tokens: 2` → `message_delta` `output_tokens: 89`. Trong ví dụ web-search, `message_delta` còn mang cả `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, và `server_tool_use`.

### 9.3 Cộng hay gán? — **GÁN (assign), không cộng**

Đây là câu hỏi quyết định việc bridge có bị double-count không. Trong accumulator của SDK (S11):

```js
case "message_delta":
  s.stop_reason   = n.delta.stop_reason;
  s.stop_sequence = n.delta.stop_sequence;
  …
  if (n.usage.output_tokens != null)            s.usage.output_tokens = n.usage.output_tokens;
  if (n.usage.input_tokens  != null)            s.usage.input_tokens  = n.usage.input_tokens;
       s.usage.cache_creation_input_tokens = n.usage.cache_creation_input_tokens;
  if (n.usage.cache_read_input_tokens != null)   s.usage.cache_read_input_tokens = n.usage.cache_read_input_tokens;
```

Phép **gán**, không phải `+=`. Và `message_start` chỉ khởi tạo state:

```js
function Ad(n) {
  if (n.type === "message_start") { …; return n.message }
  …
}
```

⇒ `message_start.usage` là **ảnh chụp một phần**, bị `message_delta` **ghi đè**.

**Kết luận: bridge gửi `output_tokens: 0` trong `message_start` là AN TOÀN — không double-count.** `CAUGHT UP`.

### 9.4 Claude Code có kiểm tra usage không?

Có (S11):

```js
var Es = (e) => N(e) && [e.input_tokens, e.output_tokens,
                         e.cache_read_input_tokens, e.cache_creation_input_tokens]
                      .every((t) => Number.isFinite(t));
```

⇒ cả **bốn** trường phải là số hữu hạn. `usageBlock()` của bridge trả đủ cả bốn. **Đúng.**

Claude Code còn tự cộng `usage.output_tokens` qua các lượt: `z += ue.message?.usage?.output_tokens ?? 0`.

### 9.5 Bridge đang làm gì, và cái giá của nó

- `output_tokens`: tính lại từ ký tự thực gửi đi ⇒ **đúng**.
- `input_tokens = tokensSpent` = **tổng của cả các lượt retry** ⇒ **phóng đại**. Claude Code cộng dồn vào bộ đếm context, nên context bị đo là to hơn thực. Kết hợp `autoCompactWindow: 450000` ⇒ compact **sớm hơn** mức cần.

Đây là lựa chọn có chủ đích (README nói rõ), và hệ quả là *thận trọng theo hướng an toàn*. Chỉ cần biết rằng nó **không phải** con số thật; và nó **không được** cộng cho `output_tokens` — bridge đã không cộng. **Đúng.**

---

## 10. Effort / `output_config`

### 10.1 `output_config` là thật

S1, định nghĩa đầy đủ:

```
output_config: optional OutputConfig
  effort: optional "low" | "medium" | "high" | "xhigh" | "max"
  format: optional JSONOutputFormat    // { type: "json_schema", schema: map }
```

S8 xác nhận: đây là **GA**, **không cần beta header** cho top-level effort, hỗ trợ trên Claude API / AWS / Bedrock / Google Cloud / Microsoft Foundry.

⇒ Bridge **không bịa**. `output_config.effort` là thật, và 5 giá trị `EFFORT_LEVELS` của bridge **khớp 100%** danh sách Anthropic. **CAUGHT UP.**

### 10.2 Nhưng: comment của `clampLevel` gán sai nguồn

`bridge.mjs` viết:

> *"Anthropic documents that an unsupported level falls back to the highest supported level AT OR BELOW the one set."*

**Tôi không tìm thấy câu này trong S8.** Trang effort nói ngược lại một điều liên quan:

> *"Setting `effort` to the model's default … produces exactly the same behavior as **omitting** the `effort` parameter entirely."*

Không có quy tắc "fallback khi mức không được hỗ trợ" nào được document. Hành vi khi gửi giá trị sai **không được document** (có lẽ 400). ⇒ **UNVERIFIED.**

### 10.3 `EFFORT_ORDER` là phát minh của bridge

```
["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultracode"]
```

Theo S8, giá trị effort hợp lệ **chỉ có** `low | medium | high | xhigh | max`. `off`, `none`, `minimal`, `ultracode` **không tồn tại** trong API. S8 còn nói rõ: *"Don't pass `adaptive` as an `effort` value: `adaptive` is a thinking mode, not an effort level."*

⇒ Đây là bảng **thứ bậc nội bộ của bridge** để clamp, hoàn toàn hợp lệ về mặt kỹ thuật — nhưng **không phải** thứ Anthropic document. `minimal`/`ultracode` trông như tên từ CLI/UI của Claude Code. `auto` mà `resolveEffort` xử lý cũng vậy: **không có trong danh sách hợp lệ.** Việc Claude Code gửi `auto` sau `/effort auto` là **quan sát thực nghiệm của tác giả repo, không phải tài liệu** — đánh dấu **UNVERIFIED**.

### 10.4 Per-message effort — khoảng trống thật trong bridge

S8 mô tả một cơ chế **beta**: effort đổi giữa cuộc hội thoại bằng cách chèn một message `role:"system"` với `content: []` và `output_config.effort` riêng, cần beta header `mid-conversation-output-config-2026-07-01`. Cần model mới (Fable 5.1, Mythos 5.1, Opus 5.5/5, Sonnet 5.5, Haiku 5.5).

**Bridge không xử lý hai điều:**

1. Chỉ đọc `body?.output_config?.effort ?? body?.effort` — **bỏ qua `output_config` ở cấp message**.
2. `buildTranscript()` coi mọi thứ không phải `role === "assistant"` là **user**:

```js
} else {
  const texts = [];
  for (const b of blocks) { if (b.type === "text") texts.push(b.text); … }
  if (texts.length) lines.push("[user] " + texts.join("\n"));
}
```

Một message `role:"system"` sẽ bị render thành `[user] …`. Đây là **bug tiềm ẩn có thật** trong `buildTranscript`, không phải suy đoán.

*Giảm nhẹ:* `claude-settings.example.json` đặt `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, nên nhiều khả năng beta này đang tắt. Vẫn nên sửa vì nó rẻ.

### 10.5 `thinking`

`bridge.log` (S13) cho thấy Claude Code gửi `thinking: "adaptive"`. Bridge log nó nhưng **không dùng** và **không bao giờ phát `thinking` block**. `flattenContent()` bỏ qua `thinking`/`redacted_thinking` khi dựng transcript.

Điều này **đúng**: S1 yêu cầu thinking block phải được gửi lại **nguyên vẹn** nếu có; bridge không bao giờ tạo ra chúng nên không có gì phải echo. Nhưng nó có một hệ quả: **cấu trúc turn của model hoàn toàn khác Claude thật** (Claude thật suy nghĩ ở `high`; model của bridge suy nghĩ ở variant OpenCode). Bridge đang ghi `reasoning: 0` trong `usage` nội bộ — vô hại vì `usageBlock()` không xuất nó ra. **OK.**

### 10.6 Effort mặc định

S8: API default là `high` (`medium` trên Opus 5.5 và Haiku 5.5). Bridge dùng `DEFAULT_EFFORT = "medium"`. Đây là lựa chọn của bridge, không sai, nhưng lệch với default của Anthropic — có chủ đích (model free). **OK.**

---

## 11. Hệ quả cho `bridge.mjs`

Xếp theo mức độ: lỗi đã được đo là mất lượt > lệch contract > độ trung thực > sạch code.

---

### P0 — Sửa ngay: đang mất lượt hoặc đang chạy do trùng hợp

#### P0.1 · Thay `ContextWindowExceededError` bằng chuỗi Anthropic thật

**Vì sao (độ tin cậy cao nhất trong bài):** chuỗi đó **không tồn tại** ở Anthropic lẫn Claude Code. Bridge chỉ hoạt động vì câu message của nó tình cờ chứa `prompt is too long`. Đây là ràng buộc **string-match** không có hợp đồng nào bảo vệ — sửa message là mất auto-compact, và triệu chứng là phiên bị kẹt.

```js
// bridge.mjs:161-166
class ContextTooLong extends Error {
  constructor(promptTokens, limit) {
    super(
      `input is too long for requested model: ${promptTokens} tokens > ${limit} maximum`
    );
    // … this.name / status / shouldRetry giữ nguyên
  }
}
```

Chuỗi này khớp `vEr()` của Claude Code theo **cả hai** nhánh (`prompt is too long` **và** `input is too long for requested model`). Giữ `status: 400` + `type: "invalid_request_error"` + `x-should-retry: false` — tất cả đã đúng.

**Sửa README** mục *"Xử lý lỗi"* và dòng ghi chú trong *"Ghi chú phát hiện trong lúc làm"*.

#### P0.2 · `Glob`: thêm remap `include → pattern`

**Vì sao:** `GlobInput` (S10) yêu cầu `pattern`; OpenCode quảng bá `include`. Bridge map `include → glob` cho `Grep` nhưng **không** cho `Glob`. Mọi lượt gọi `Glob` đều schema violation.

```js
// INPUT_KEY_MAP
Glob: { include: "pattern", filePattern: "pattern", glob: "pattern" },
```

#### P0.3 · Thay `DROP_INPUT_KEYS` cụ thể bằng allowlist tổng quát

**Vì sao (lớn nhất trong danh sách):** `input_schema` của Claude Code là Zod-4-output-mode ⇒ **`additionalProperties: false` ở mọi object**. `DROP_INPUT_KEYS` hiện chỉ bịt `workdir`/`cwd`/`shell` trên `Bash`. Bất kỳ khoá dư nào — do model bịa, do mượn từ schema rộng hơn của OpenCode, do `replaceAll` thay vì `replace_all` — đều là **InputValidationError giết cả lượt**. Chi phí: 1 lượt retry + 1 upstream call.

Đổi `validateInput()`/`remapInput()` sang chiến lược allowlist:

```js
// sau khi remap key, trước khi validate:
if (schema?.additionalProperties === false && schema?.properties) {
  for (const k of Object.keys(mapped)) {
    if (!(k in schema.properties)) {
      delete mapped[k];
      droppedKeys.push(k);          // đưa vào log + correction message
    }
  }
}
```

Bỏ `DROP_INPUT_KEYS` (trừ khi còn giữ `Bash` như trường hợp đặc biệt để *ghi log* rằng `workdir` bị bỏ — vì đó là thông tin chẩn đoán có giá trị: model muốn chạy lệnh ở thư mục khác).

Lý do an toàn: bỏ một khoá mà schema không khai báo **không bao giờ** làm thay đổi ý nghĩa lời gọi tool, vì Claude Code vốn dùng Zod strip-mode và cũng sẽ bỏ nó. Nó biến "mất lượt" thành "chạy đúng".

#### P0.4 · `Edit`: `replaceAll → replace_all`

**Vì sao:** `FileEditInput` (S10) dùng `replace_all`. Nếu OpenCode quảng bá `replaceAll`, model sẽ gửi sai tên và `additionalProperties:false` loại bỏ nó ⇒ `Edit` chạy với `replace_all` mặc định `false` ⇒ **sửa sai chỗ, không báo lỗi**. Đây là loại bug nguy hiểm nhất trong danh sách: im lặng và sai.

```js
Edit: { …, replaceAll: "replace_all", replace_all: "replace_all" }
```

---

### P1 — Sửa sớm

#### P1.1 · Xoá alias `todoread: ["TodoRead"]`

Không có tool `TodoRead` trong Claude Code (0 lần trong `claude.exe`). Nó chỉ làm bẩn bảng alias và gây hiểu nhầm khi đọc.

#### P1.2 · Sửa comment của `clampLevel` và `EFFORT_ORDER`

Comment hiện tại khẳng định một quy tắc mà Anthropic **không document**. Ghi lại thành chính sách của bridge:

```js
/**
 * CLAMPING IS BRIDGE POLICY, NOT AN ANTHROPIC RULE.
 * Anthropic documents exactly five values: low | medium | high | xhigh | max.
 * It does NOT document what happens for an unsupported value, and the
 * "highest supported level at or below the one you set" fallback that this
 * used to claim is not in the effort docs.
 * `off`/`none`/`minimal`/`ultracode`/`auto` below are Claude Code / bridge
 * vocabulary, never API values — they exist so a CLI-side value maps onto
 * something this model actually offers.
 */
```

Không đổi hành vi. Đổi **mức trung thực của tài liệu trong repo**.

#### P1.3 · `buildTranscript` phải hiểu `role: "system"`

Bug tiềm ẩn có thật: hiện tại mọi message không phải assistant đều thành `[user] …`. Cho per-message effort (beta, S8) vào là sai ngay. Sửa tối thiểu:

```js
} else if (msg.role === "system") {
  // effort-only control message (mid-conversation-output-config beta);
  // content is [] by design
  continue;
} else {
  …
}
```

Kèm theo: đọc `output_config.effort` của **message cuối cùng** trong `messages` trước khi fallback về top-level. Chi phí ~8 dòng.

#### P1.4 · Hạ trần body về 32 MB

S4: Messages API tối đa **32 MB**, quá là **413 `request_too_large`**. Bridge đọc `64 * 1024 * 1024`. Sửa `readBody(req, limitBytes = 64 * 1024 * 1024)` → `32 * 1024 * 1024` để `413` bắt đúng chỗ và không phải gom một body 40 MB rồi mới từ chối.

#### P1.5 · Tôn trọng `disable_parallel_tool_use`

Bridge bỏ qua hoàn toàn. Nếu request có `tool_choice.disable_parallel_tool_use === true`, cắt còn **tối đa 1** `tool_use` block (giữ block đầu, bỏ các block sau cùng `telemetry` đếm việc đã bỏ). Không có nó, Claude Code có thể chạy 5 tool khi client đã yêu cầu tối đa 1.

---

### P2 — Độ trung thực và vệ sinh

#### P2.1 · `stop_sequences`

Bridge bỏ qua `body.stop_sequences` và luôn trả `stop_sequence: null`. Nếu Claude Code từng gửi nó, bridge im lặng không tuân thủ. Tối thiểu: **từ chối có chủ đích** (`400 invalid_request_error: bridge does not implement stop_sequences`) thay vì im lặng bỏ qua — lỗi rõ ràng hơn hành vi sai âm thầm.

#### P2.2 · `message_start.usage.output_tokens: 0` → số nhỏ dương

S2 cho thấy Anthropic gửi giá trị nhỏ **không phải 0** (1, 2, 3). Vì `message_delta` **gán chứ không cộng** (S11), `0` **không gây sai số** — nên đây là thuần về độ trung thực, không phải bug. Sửa một dòng cho khớp hình dạng thật; **không** sửa nếu bạn muốn giữ diff nhỏ.

#### P2.3 · Thứ tự block trong assistant response

Bridge xếp `tool_use` trước, `text` sau. Anthropic (S6) và Claude thật đặt `text` trước. Tôi **không tìm thấy** ràng buộc nào ở phía assistant ⇒ không phải bug. Nhưng: (a) khớp hình dạng chuẩn giúp bất kỳ so sánh transcript nào sau này đáng tin hơn; (b) `RESPONSE_PROTOCOL` của bridge vốn bảo model để `text` trống khi gọi tool, nên gần như không có gì để sắp lại.

#### P2.4 · `validateInput` hiểu ràng buộc số của Zod 4

Bổ sung `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`/`minItems`/`maxItems`/`const`. Bắt được trước: `Read.limit: 0` (`int().positive()` ⇒ `exclusiveMinimum: 0`), `AskUserQuestion.questions` ngoài 1..4. Mỗi lần bắt được là một lượt retry tiết kiệm.

#### P2.5 · Cân nhắc lại `EmptyTurn` → 400

S3 (accordion *Empty responses with end_turn*) nói: **response rỗng với `end_turn` là hành vi đã biết và lành tính**, và khuyến nghị client xử lý bằng cách thêm một continuation prompt chứ **không** coi là lỗi.

Bridge hiện trả `400` + `x-should-retry: false` ⇒ Claude Code **hard-fail turn**. Với một bridge vốn dựa trên tuân thủ prompt, đây là lựa chọn hợp lý (fail loud hơn là im lặng). Nhưng đáng cân nhắc phương án thay thế: trả `200` + `stop_reason: "end_turn"` + một text block ngắn nói rõ model không tạo ra envelope, để Claude Code tự tiếp tục. Ghi lại quyết định và lý do trong README — hiện tại nó mới chỉ là hành vi.

#### P2.6 · `retry-after-ms` cạnh `retry-after`

Không cần thiết. `retry-after: "2"` đã đúng (SDK `parseFloat` × 1000). Chỉ thêm nếu muốn độ trễ dưới 1 giây.

---

### P3 · Đóng lại các lỗ hổng kiến thức

Các mục dưới đây là **UNVERIFIED** và nên được đóng lại bằng một lần đo, không bằng suy luận:

1. **Schema của `LS`, `NotebookRead`, `Skill`** — bridge alias cả ba nhưng không biết hình dạng input. Nếu model gọi `LS` với khoá sai thì hỏng không hiểu vì sao.
2. **Bộ tool đầy đủ 23 tool** mà Claude Code gửi trong một turn (repo đo được con số nhưng không lưu danh sách).
3. **Khoá input của `task` của OpenCode** — bridge không map gì cho `Task`; chỉ đúng nếu tên khoá trùng.

**Cách đóng lại rẻ nhất, không tốn token:** trong `bridge.mjs`, khi `BRIDGE_DEBUG=1`, ghi `body.tools` vào `bridge.log` (đã có sẵn `logRequest`; hiện chỉ ghi `tools: allowed.length`). Một lần `claude -p "hi"` là đủ để có bảng schema chuẩn, rồi bỏ lại cờ debug. Đây cũng là cách duy nhất xác nhận chắc chắn `required` thật của từng tool thay vì suy ra từ Zod.

---

### Tóm tắt: cái bridge đã làm đúng, và vì sao

| Hành vi bridge | Phán quyết |
|---|---|
| `truncated ? "max_tokens" : hasTool ? "tool_use" : "end_turn"` | ✅ **Đúng** — và nay có cơ sở: Claude Code map `max_tokens` → `"stop"`, không chạy tool |
| `content_block_start` với `input: {}` | ✅ đúng (S2) |
| Gửi `partial_json` = JSON của **toàn bộ** input trong một delta | ✅ đúng — nối chuỗi cho ra object, Claude Code parse ở `content_block_stop` |
| `index` tuần tự `0..n-1`, mọi block đóng bằng `content_block_stop` | ✅ bắt buộc — lệch là delta rơi mất |
| `x-should-retry` trên mọi lỗi + `retry-after` khi retryable | ✅ **đúng, có nguồn sơ cấp** (S9) |
| `message_start.usage.output_tokens: 0` | ✅ an toàn — `message_delta` **gán** chứ không cộng |
| `usageBlock()` phát đủ 4 trường số | ✅ bắt buộc — Claude Code kiểm tra cả 4 bằng `Number.isFinite` |
| Giữ `tool_result` đầu user message, text sau | ✅ bắt buộc (S6) |
| `tool_choice: none` lọc hết tool_use; `tool_choice: tool` lọc theo tên | ✅ đúng |
| Drop `workdir`/`cwd`/`shell` trên `Bash` | ✅ **đúng** — và nay chứng minh được từ `BashInput`, không còn là đoán |
| Không alias `patch` / `webfetch` / `subagent` | ✅ đúng |
| Không alias tên dạng `mcp__…` | ✅ đúng |
| `ContextWindowExceededError` trong message overflow | ❌ **sai** — chuỗi không tồn tại; chạy được do trùng `prompt is too long` |
| `Glob` không remap `include → pattern` | ❌ **sai** |
| Chặn bằng `DROP_INPUT_KEYS` cụ thể thay vì allowlist | ❌ **không đủ** — mọi object đều `additionalProperties: false` |
| `EFFORT_LEVELS` = 5 mức của Anthropic | ✅ đúng, 100% khớp S8 |
| `EFFORT_ORDER` + comment gán "Anthropic documents…" | ⚠️ hành vi ổn, **tài liệu sai nguồn** |