# Claude Code ↔ OpenCode bridge

Chạy **Claude Code CLI** với model **Space Bunny Free** (free tier của OpenCode), bằng cách
đi qua một `opencode serve` chạy local.

```
claude  ──Anthropic POST /v1/messages──▶  bridge.mjs  ──HTTP──▶  opencode serve  ──▶  space-bunny-free
              127.0.0.1:8787                              127.0.0.1:4599
```

---

## Vấn đề gốc

Ba rào cản, tất cả đều đã kiểm chứng bằng API thật:

1. **Claude Code chỉ nói được Anthropic Messages API** (`POST {BASE}/v1/messages`).
2. **`space-bunny-free` chỉ có endpoint `/chat/completions`** trên gateway OpenCode.
3. **OpenCode chặn cứng free tier** khi gọi từ client không phải OpenCode:

```
403 {"type":"error","error":{"type":"FreeTierError",
  "message":"OpenCode's free tier can only be used from within OpenCode."}}
```

Đã thử với cả API key `oc_sk_…` lẫn OAuth token, trên cả `/chat/completions` và `/v1/messages`
→ **cùng một lỗi**. Không phải lỗi cấu hình.

Cách duy nhất hợp lệ: để **chính OpenCode** phát ra request suy luận.

---

## Ba ràng cản thiết kế

Mọi quyết định kiến trúc đều xoay quanh ba điều đã kiểm chứng thực nghiệm, không phải giả định.

### 1. Chỉ dùng route raw, không dùng agent loop

`opencode serve` có hai kiểu gọi model:

| Route | Agent loop | Tool |
|---|---|---|
| `POST /api/session/{id}/prompt` | có | bash / edit / write / read / … |
| `POST /api/session/{id}/generate` | **không** | **không** |

Bridge dùng `/generate`. Đây là điểm **an toàn quan trọng nhất**: không có kênh gọi tool nào,
nên model **không thể** chạy lệnh hay ghi file trên máy bạn qua con đường này.

> **Đã thử và đã bác bỏ** cách dùng `/prompt` + cấu hình chặn: `permissions: deny` **không** chặn
> được `shell`. Test canary thực tế: model chạy lệnh PowerShell thật và tạo file `CANARY.txt`
> chứa `PWNED`. Vì vậy bridge **không** dùng `/prompt` và **không** tin vào permission config.

### 2. OpenCode không nhận tool schema tùy ý

Đo trực tiếp trên `opencode.json`:

| Cấu hình agent | Kết quả |
|---|---|
| `tools: {name: false, …}` | ❌ `403 FreeTierError` |
| `permission: {bash: "deny"}` | ❌ `403 FreeTierError` |
| `permissions: [{action, resource, effect}]` | ✅ chạy ổn định |

Nên tool calling được **mô phỏng bằng text**:

1. Tool schema của Claude Code được render thành JSON trong prompt.
2. Model được yêu cầu trả về envelope `{"text": …, "tools":[{"name","input"}]}`.
3. Bridge parse ngược thành block Anthropic `tool_use` thật.
4. Argument được validate lại theo `input_schema` trước khi phát ra.

### 3. Effort khớp đúng tên với variant

`GET /api/model` của `opencode serve` công bố variant cho model:

```json
"variants": [
  { "id": "low",  "settings": { "reasoningEffort": "low" } },
  { "id": "medium", "settings": { "reasoningEffort": "medium" } },
  { "id": "high", "settings": { "reasoningEffort": "high" } },
  { "id": "xhigh", "settings": { "reasoningEffort": "xhigh" } },
  { "id": "max", "settings": { "reasoningEffort": "max" } }
]
```

Đúng bằng 5 mức effort của Claude. Bridge chuyển `output_config.effort` → `variant`.

---

## Dùng

```powershell
# 1. Bật bridge (cửa sổ riêng, để nguyên)
powershell -ExecutionPolicy Bypass -File ".\start-bridge.ps1"

# 2. Dùng Claude Code
claude
```

Hoặc một lệnh:

```powershell
.\claude-bridge.ps1                     # tự bật bridge nếu chưa chạy rồi mở claude
.\claude-bridge.ps1 -p "fix the tests"  # kèm tham số
```

Dừng:

```powershell
powershell -ExecutionPolicy Bypass -File ".\stop-bridge.ps1"
```

Chạy test:

```powershell
powershell -ExecutionPolicy Bypass -File ".\run-tests.ps1"
```

Mặc định **276 assert, không tốn token nào**: `unit` (141) + `http` (47) + `mock` (88).

`mock` là suite quan trọng nhất và là suite mới: nó dựng một `opencode serve` giả rồi chạy
`bridge.mjs` thật (tiến trình con) đối diện với nó. Nhờ vậy test được toàn bộ contract —
streaming, error taxonomy, session cache, concurrency — **deterministic, miễn phí, và không
bị rate limit**. Đây cũng là chỗ duy nhất có thể kiểm chứng nhánh "turn nhanh" và "turn chậm"
một cách có chủ đích.

Trước đó năm suite còn lại gọi model thật, nên mỗi lần chạy đều tốn token, và ở free tier bị
provider rate limit giữa chừng — phần còn lại của suite báo lỗi rate limit chứ không phải lỗi
bridge. Chúng giờ là opt-in:

```powershell
powershell -ExecutionPolicy Bypass -File ".\run-tests.ps1" -Live
powershell -ExecutionPolicy Bypass -File ".\run-tests.ps1" -Live -LiveCount effort   # rẻ nhất
```

> `claude` **phụ thuộc** bridge. Bridge tắt thì `claude` không chạy được.
>
> Khi bridge tắt, Claude Code báo `Connection refused — a firewall or proxy may be blocking
> it (ECONNREFUSED)`. **Câu đó dẫn sai hướng** — không có firewall nào liên quan; chỉ đơn
> giản là chưa có gì lắng nghe ở `127.0.0.1:8787`. Dùng `.\claude-bridge.ps1` thay vì gọi
> `claude` trực tiếp: nó tự bật bridge nếu đang tắt rồi mới mở Claude Code.
>
> `bridge.log` ghi cả vòng đời tiến trình (`startup` / `exit`), nên phân biệt được ngay:
> **có** dòng `exit` = tắt có trật tự hoặi crash (dòng đó ghi cả lý do); **không** có dòng
> `exit` = bị giết từ bên ngoài — thường là đóng cửa sổ console đã khởi chạy nó.

---

## Effort

Cách chỉnh, theo thứ tự ưu tiên:

1. `/effort high` trong phiên, hoặc `claude --effort max` khi launch
2. `CLAUDE_CODE_EFFORT_LEVEL=low` trong shell
3. `effortLevel` trong `~/.claude/settings.json`
4. Mặc định của bridge — `.\effort.ps1 high`, hoặc `POST /effort`

```powershell
.\effort.ps1 -List      # xem hiện tại
.\effort.ps1 max        # đổi mặc định
```

Khóa cứng, bỏ qua mọi effort của request: đặt `BRIDGE_EFFORT=max` khi start bridge.

**Đo được hiệu ứng thật** (cùng một câu hỏi, qua `opencode serve`):

| Variant | Thời gian | Reasoning tokens |
|---|---|---|
| `low` | 2.0s | 7 |
| `max` | 4.1s | 102 |

**Phần quan trọng nhất**: `/effort` chỉ xuất hiện nếu Claude Code **nhận ra** model hỗ trợ effort.
Key `modelPicker.options[].behavesAs` là thứ làm điều đó — xem [SETTINGS.md](SETTINGS.md).

---

## Chi phí token mỗi turn

Đo trên một turn hình dạng Claude Code thật (23 tool, hội thoại có tool result 30 KB):

| Phần | Token | Ghi chú |
|---|---|---|
| Schema 23 tool + protocol | ~7 300 | **giống hệt nhau mọi turn** |
| Hội thoại + tool result | ~8 900 | phần thay đổi |
| **Tổng (ước lượng của bridge)** | **~16 200** | |
| Claude Code thật, đo từ `bridge.log` | ~42 000 | 26 tool, hội thoại sâu hơn |

Khối 7.3k kia lặp lại nguyên vẹn mỗi turn và **không thể cache** — không chỉ vì `/generate`
không lưu message, mà vì `buildTranscript()` nén mọi thứ thành **một chuỗi duy nhất**. Gateway
đặt điểm gãy cache ở cuối message đủ điều kiện gần nhất rồi nhìn lại các điểm gãy *trước đó*;
với đúng một message thì không có điểm gãy nào để nhìn lại. Nên kể cả khi cổng có cache, mức
tái sử dụng cũng gần bằng 0. Prompt caching là ngõ cụt ở đây.

### Token lớn nhất không nằm ở schema, mà ở **retry**

Đo từ `bridge.log` (62 turn hoàn tất, **0 token**):

```
phí retry = 471 340 token = 34,1% tổng input
17/62 turn (27,4%) cần ≥ 2 lượt
prompt trung bình 14 691 · lớn nhất 75 517
```

Một lượt retry thừa là **một lần gửi lại toàn bộ prompt**. Ở turn thật 42 588 token, mỗi lượt
thừa lãng phí ~42 600 token. Thứ tự ưu tiên đúng là **giảm số lượt retry kích hoạt**, không
phải tinh chỉnh schema. Phần lớn nguồn retry đã được vá: `tool_choice: any` không được ép,
`best` nuốt mất tool call, hình dạng OpenAI bị vứt, `webfetch` tự đốt một retry.

### Xoá tool result theo **tuổi**

Trần theo kích thước không diễn đạt được điều này: một kết quả từ 20 lượt trước tốn y hệt kết
quả của lượt này, và đến lúc đó model đã gần như đi sang việc khác. Anthropic gọi clearing là
*"one of the safest lightest touch forms of compaction"*. 6 kết quả gần nhất được giữ nguyên,
kết quả cũ hơn thay bằng một dòng nói rõ có thể gọi lại.

Đo được:

| Kịch bản | Có clearing | Không | Tiết kiệm |
|---|---|---|---|
| 14 result × 8 KB (thực tế) | 21 449 | 43 874 | **51%** (~22 400 token/turn) |
| 14 result × 40 KB | 90 020 | 89 889 | 0 — ngân sách tổng đã chặn trước |

**Đừng rút ngắn mô tả tool.** Trực giác bảo mô tả ngắn là tiết kiệm; tài liệu Anthropic khuyên
ngược lại — *"Provide extremely detailed descriptions… Aim for at least 3–4 sentences for each
tool description"*, và gọi bản mô tả ngắn là ví dụ **xấu**.

**Đo hành vi model đừng dùng `claude -p`.** Một lượt Claude Code tốn ~32 000 input token trước
khi model làm bất cứ việc gì, vì 23 tool schema cộng system prompt. `probe-behaviour.mjs` gửi
3 tool và prompt một dòng — khoảng 1/20 chi phí:

```powershell
node probe-behaviour.mjs        # 4 case
node probe-behaviour.mjs 5      # lặp 5 vòng để đo tỉ lệ
```

Nó **báo cáo, không assert**: một model free được phép hành xử khác nhau giữa những ngày khác
nhau, và suite fail vì lý do đó dạy bạn phớt lờ suite. Dùng `test-mock.mjs` cho contract, dùng
probe này cho xu hướng.

---

## An toàn: điều gì thực sự giữ model khỏi máy bạn

**Hai lớp, và cả hai đều đã kiểm chứng thay vì giả định.**

**1. `/generate` là route completion thuần** — không agent loop, không tool catalog. Không có
kênh gọi tool nào để model đi qua. Đây là lớp chính.

**2. `permissions: deny` giờ thực sự nạp** (trước đây **không**). `opencode.json` dùng khoá
`"agent"` số ít, còn V2 dùng `"agents"`. Parser nuốt cả object lạ và biến các rule
permission thành field JSON gửi thẳng cho provider — nên **không một rule nào được nạp**, và
`ccbridge` chạy với ruleset mặc định `*/* allow`.

> Canary test ban đầu ("`shell` vẫn chạy lệnh thật, tạo file `CANARY.txt` chứa `PWNED`") đo
> **đúng** hiện tượng nhưng **sai** nguyên nhân. Đó là bài học: một phép đo bất thành công
> chỉ có giá trị nếu bạn biết nó đo cái gì.

Sau khi sửa, kiểm chứng bằng `POST /api/session/{id}/permission` (endpoint đánh giá, **không
gọi model**):

```
shell  -> deny      read  -> deny      execute -> deny
bash   -> deny      write -> deny      glob    -> deny
edit   -> deny      task  -> deny
```

Bốn cách **không** giữ được, đã thử và đo:

| Cách thử | Kết quả |
|---|---|
| `tools: {…: false}` (deprecated) | `403 FreeTierError` |
| `permission` (object form) | `403 FreeTierError` |
| `agent: "ccbridge"` + `system: ""` | set được, nhưng `opencode serve` vẫn inject system prompt (~7k token) |
| `/prompt` (có agent loop thật) | OpenCode tự chạy tool; không có chỗ để bridge chặn ở giữa |

Đo trực tiếp: `/generate` với và không có `agent` đều cho model thấy bộ tool của OpenCode.
Không có field nào trong payload `/generate` tắt được nó.

Bridge chủ động chặn phần còn lại: mọi tên tool không thuộc danh sách Claude Code gửi kèm đều
bị loại và nói lại cho model, kèm kiểm tra `input_schema`.

---

## Chuẩn hóa tên tool

`opencode serve` tự inject system prompt quảng bá tool **của nó**: `shell`, `read`, `write`,
`edit`, `grep`, `glob`, `list`. Model hay trả đúng tên đó, và Claude Code từ chối với
`No such tool available`. Bridge map về tên Claude Code thật, kèm tham số:

| Model gửi | Claude Code nhận | Tham số |
|---|---|---|
| `shell` | `Bash` | giữ `command`, `description`; **bỏ** `workdir`/`cwd` |
| `read` | `Read` | `filePath` → `file_path` |
| `write` | `Write` | `filePath` → `file_path` |
| `edit` | `Edit` | `filePath` → `file_path`, `oldString`/`newString` → `old_string`/`new_string`, `replaceAll` → `replace_all` |
| `grep` | `Grep` | `include` → `glob`, `limit` → `head_limit`; **bỏ** `caseSensitive` |
| `glob` | `Glob` | `include` → `pattern`; **bỏ** `hidden`, `limit` |
| `list` / `ls` / `dir` | `LS` → `Glob` → `Bash` | Claude Code **không có** tool `LS`, nên phải có fallback |

**Vì sao phải map/bỏ key thay vì chuyển thẳng.** `input_schema` của Claude Code sinh từ Zod với
`io:"output"`, nên **mọi** object đều có `additionalProperties: false`. Schema của OpenCode rộng
hơn, và system prompt của nó **dạy model** dùng các key đó. Bridge vì thế đang được dạy để gửi
key mà chính nó sẽ reject.

Nghiêm trọng nhất là `replaceAll`: lọt nó qua là `Edit` thay **một** lần thay vì **tất cả** —
và không có lỗi nào báo ra. Tương tự `Glob.path` sai thành `Glob.pattern` là match nhầm mà
không có tín hiệu. `caseSensitive` **không** map được mà phải bỏ, vì Claude Code dùng `-i` —
nghịch đảo chiều.

Hai chốt an toàn:

- **Tên dạng MCP không bao giờ được alias.** `mcp__ide__readFile` không thành `Read` của đĩa
  cục bộ. Và khi một tên không-namespaced trùng tail với tool có namespace
  (`readFile` vs `mcp__ide__readFile`) thì bridge **từ chối** thay vì đoán — đoán sai là đọc
  nhầm nguồn dữ liệu rồi vẫn trả lời tự tin.
- **Argument phải khớp `input_schema`**, kể cả `type` dạng mảng, `nullable`, `anyOf`, và
  object lồng trong `items` (hình dạng của `TodoWrite`, `AskUserQuestion`). Lệch thì bị đưa
  vào nhánh retry với thông điệp đúng loại lỗi, thay vì phát `tool_use` mà Claude Code
  từ chối bằng `InputValidationError`.

Bảng alias **cố ý hẹp**: chỉ từ vựng tool của OpenCode và vài từ đồng nghĩa thông thường.
`readFile` kiểu camelCase **không** có trong bảng — đó là dạng tail của tool MCP. `patch` và
`webfetch` bị loại vì mapping là bất khả thi (diff thuần vs `old_string`/`new_string`;
`format` vs `prompt`), nên chỉ tạo ra schema violation rồi đốt một lượt retry. Vì có nhánh so
khớp không phân biệt hoa thường **đứng trước** bảng alias, `webfetch` từng lọt qua đúng lối đó
— nên nay có `IMPOSSIBLE_ALIASES` kiểm tra trước.

---

## "Nói thay vì làm" — kiểu chết tệ nhất

Model đôi khi viết *"Okay, continuing to read the rest of bridge.mjs, and kicking off research in
parallel"*. Đó là **mô tả** hành động, không phải hành động. Turn kết thúc `end_turn` với 0
tool call, Claude Code hiện "done", và **không có lỗi nào** để báo.

Vòng review v4 đo được: 2/3 turn đầu thất bại, lượt cuối trả prose, cả turn chết trong im lặng.

Ba lớp chống, theo thứ tự:

1. **Prompt** — luật "không mô tả hành động, hãy làm nó" ở cả protocol lẫn closer cuối, có tác
   dụng ngay từ lượt 0.
2. **Correction riêng** — `narrated` khác `envelope`: *"describing an action performs none of
   it"*.
3. **`midToolLoop`** — phân biệt **kể sẽ làm giữa vòng lặp tool** với **câu mở đầu bình thường**,
   đọc từ chính request: tin nhắn user cuối chỉ gồm `tool_result`, và chỉ model mới tạo được
   tình huống đó. Giữa vòng lặp + narration → `400` nói thẳng lý do.

`looksLikeNarration` được hiệu chỉnh trên 9 câu thật, và **cả hai chiều đều có test**:

| Câu | Kết quả mong muốn |
|---|---|
| `"Okay, continuing to read the rest…"` | narration |
| `"Continuing to read the rest…"` (không mở đầu "Okay") | narration |
| `"I'll read the file for you."` | narration |
| `"Okay, here is the summary you asked for."` | câu trả lời |
| `"Sure, let me summarize what I found: effort is high."` | câu trả lời |
| `"Okay, here is my plan:\n1. read…"`, 300 ký tự | câu trả lời |

Bản đầu tiên của regex bắt **1/7** mẫu — kể cả chính ví dụ nằm trong docstring của nó — vì nó
đòi mở đầu bằng `Okay`/`Sure`. Nguyên nhân là quyết định dựa trên **từ mở đầu**, và "Okay" hay
"I'll" không quyết định điều gì.

### Ba đường mất tool call hợp lệ — đã chặn

- **`tool_choice: any` bị lách.** Hậu kiểm chỉ có cho `type:"tool"`, nên một câu trả lời văn
  xuôi được tin là đã thoả `any`. Turn đóng `end_turn` trong khi client đã yêu cầu tool.
- **`best` chấm điểm theo độ dài text.** `tools * 1000 + text.length` nghĩa là một đoạn văn
  dài 1001 ký tự **thắng** một lời gọi `Read` thật. Nay so sánh tool trước, text sau (có trần).
- **Envelope dạng mảng `[{name,input}]`** — đúng hình dạng native tool calling mà cả kiến trúc
  sinh ra để chống lại — bị biến thành **JSON thô hiện ra cho user** với `end_turn`. Nay được
  nhận thành tool call thật, và nhánh prose không bao giờ render JSON thô nữa.

**`workdir` bị bỏ chứ không bị reject** — trường hợp đo được: model thêm `workdir` vì schema
`bash` của OpenCode quảng bá nó, còn `Bash` của Claude Code có `additionalProperties: false`.
Validator **đúng** khi reject, nhưng mỗi turn `Bash`+`Read` song song sẽ đốt một lượt retry.
Bỏ `workdir` cho đúng lệnh mà model vốn muốn, vì Claude Code vốn chạy `Bash` ở thư mục
session. Sau khi sửa: 8/9 turn chính thành công ngay lượt đầu (đo trên 3 lần chạy `claude -p`
thật, trước đó là 5/8).

---

## Hợp đồng streaming

`claude` là client chính của mình, nên bridge theo đúng contract Anthropic:

- Sự kiện đầu tiên **luôn** là `message_start`, không phải `ping`.
  Keep-alive là **SSE comment** (`: keep-alive`), không phải event — parser bỏ qua.
  *(Đã từng phát `event: ping` trước `message_start`; đo được 7 ping trước message_start
  trên một lượt 53s. Đã bỏ.)*
- Thứ tự: `message_start` → (`content_block_start` / `_delta` / `_stop`)\*n → `message_delta`
  → `message_stop`.
- Lỗi giữa chừng: chỉ phát `error`, **không** phát `message_stop`. Anthropic kết thúc stream
  bằng `error` và bỏ `message_stop`; phát nó trước sẽ báo cho client rằng turn thành công rồi
  để lại một cặp thất bại.
- **HTTP status trì hoãn cho tới khi có phản hồi đầu tiên**, nên lỗi nhanh vẫn trả được
  status code thật thay vì `200` rỗng. Đặc biệt quan trọng cho **context overflow**:
  Claude Code tự compact khi body lỗi chứa `prompt is too long` hoặc
  `input is too long for requested model`.
  *(Đã kiểm tra binary `claude.exe`: chuỗi `ContextWindowExceededError` **không xuất hiện ở đâu
  cả** — không trong tài liệu Anthropic, không trong client. Bridge từng "chạy được" chỉ vì cụm
  ba chữ đầu của nó trùng với `prompt is too long` theo tình cờ. Giờ dùng đúng hai chuỗi mà
  client thật sự match.)*
  *(Đã từng gọi `close()` trước `sendError()`, biến mọi lỗi nhanh thành `200` rỗng; hai
  reviewer độc lập cùng chỉ ra. `close()` giờ không `end()` nếu head chưa được gửi.)*
- **`message_start` được phát đúng một lần, từ một chỗ duy nhất** — `onHead` của
  `DeferredSSE`, chạy khi cái đầu tiên giữa timer và writer commit head.
  *(Đã từng có hai nơi phát: khi model trả lời nhanh hơn `HEAD_DELAY_MS`, `ensureHead()` gọi
  `onHead` ra bản #1 rồi `handleMessages` phát bản #2 với `message.id` khác. Đó là **đa số
  turn**, vì `/generate` trong 1–3s còn `HEAD_DELAY_MS` là 2.5s. `test-mock.mjs` kiểm chứng
  được: cố ý tái phát lỗi thì suite đỏ 4 assert, sửa thì xanh.)*
- Ngay khi head được gửi, bridge mở `message_start` luôn — `/generate` không stream được,
  nên đây là tín hiệu duy nhất cho biết turn đang chạy thay vì treo.

---

## Xử lý lỗi

| Tình huống | Bridge trả về | Claude Code làm gì |
|---|---|---|
| Prompt vượt giới hạn input | `400` + `x-should-retry: false` | tự compact rồi thử lại |
| Model không tạo envelope sau 3 lượt | `400`, **không** retry | báo lỗi, dừng |
| Body thiếu `model`/`messages`/`max_tokens` | `400 invalid_request_error`, **không** gọi model | báo lỗi, không tốn token |
| Body quá 64 MB | `413 request_too_large` | báo lỗi |
| Route không tồn tại | `404`; route đúng sai method thì `405` | — |
| OpenCode 5xx / rate limit | status gốc, `x-should-retry: true` + `retry-after` | retry |
| Hết `BRIDGE_TURN_BUDGET_MS` | `503 overloaded_error` + `retry-after` | retry |
| Vượt giới hạn request đồng thời | `429` + `retry-after: 5` + `x-should-retry: true` | retry sau |
| Lỗi nội bộ của bridge | `500 api_error` + `x-should-retry: false` | không retry |
| Client ngắt kết nối | hủy request upstream | dừng trả tiền cho câu trả lời không ai đọc |

Bridge **không** echo nguyên body lỗi của OpenCode ra client (có thể là credential do provider
chọn nhúng vào). Nguyên nhân gốc vẫn nằm trong `bridge.log`.

`usage` luôn mô tả **cái thực sự đã gửi**: `output_tokens` được tính lại sau khi cắt theo
`max_tokens`, và `input_tokens` là tổng của cả các lượt retry — vì Claude Code cộng dồn hai số
này vào bộ đếm context của nó.

`EmptyTurn` **cố ý không retry**: ba lượt nội bộ đã thử, và lỗi là tất định với một prompt —
client gửi lại y hệt sẽ tốn thêm ba lượt upstream để nhận cùng câu trả lời rỗng.

Retry tối đa **3 lượt** cho: reply rỗng, tên tool sai, argument sai schema, hoặc `tool_choice`
bắt buộc gọi tool mà model không gọi. Mỗi lượt thêm một chỉ dẩn `[CORRECTION]` **chỉ đúng
loại lỗi đó**. Nếu lượt sau tệ hơn lượt trước, bridge giữ lại lượt tốt nhất. Lượt cuối, một
câu trả lời văn xuôi vẫn được trả về như tin nhắn thay vì báo lỗi.

Cả một turn có deadline riêng (`BRIDGE_TURN_BUDGET_MS`, mặc định 240s) bọc **cả** lượt đầu —
nếu chỉ kiểm tra giữa các lượt thì một `/generate` treo sẽ giữ một slot đồng thời suốt thời
gian chờ upstream.

---

## Session của OpenCode

`/generate` **không** lưu message vào session — session chỉ giữ variant model cuối cùng. Vì vậy
reuse session không mang lại prompt caching nào. Session được **khoá theo variant**:

- tối đa 5 session (5 variant + `default`), không rò rỉ
- request cùng variant không race nhau
- request khác variant dùng session khác, nên effort không bị đè

Việc kiểm tra session còn sống **nằm trong** promise single-flight, không nằm ngoài nó. Trước
đây mọi request đồng thời đều thấy cùng một session chết, mỗi request xoá entry mà request
khác vừa cài, rồi mỗi request tự tạo session — N-1 session không ai giữ tham chiếu và không
bao giờ bị `DELETE`. Đây đúng là kịch bản xảy ra mỗi khi `opencode serve` restart giữa
chừng. `test-mock.mjs` giờ chặn được điều này.

---

## Hạn chế đã biết

- **Ảnh không được truyền.** `/generate` nhận `prompt` là chuỗi và **bỏ qua mọi trường đính
  kèm** — đã thử `files`, `image`, `images`, `attachments`, `content`, `parts`, `data:` URI,
  đều không tới được model. Bridge thay bằng dòng báo rõ ràng kèm số byte base64, để model không
  đoán bừa. **Claude Code vẫn đọc được file ảnh; chỉ model không thấy nội dung.**
- **Không có prompt caching.** Mỗi lượt gửi lại toàn bộ context, cộng thêm ~6.7k token system
  prompt của OpenCode. Chậm hơn Claude Code thật, nhưng model free nên không tốn tiền.
- **Tool calling dựa trên tuân thú prompt**, không phải native function calling. Bridge có retry
  nhưng không loại bỏ hoàn toàn việc model nói thay vì gọi.
- **Ước lượng token.** `/generate` không trả usage. Dùng 2.8 char/token — thận trọng, để
  `autoCompactWindow` kích hoạt sớm hơn giới hạn thật.
- **Chỉ chạy trên Windows + OpenCode đã đăng nhập** (bridge dùng credential đã lưu của chính
  OpenCode). Không cần paste API key vào Claude Code.
- `/debug/*` không xác thực. Chỉ bind `127.0.0.1`, nhưng mọi process local đều đọc được.

---

## Endpoint của bridge

| Method | Path | Ghi chú |
|---|---|---|
| POST | `/v1/messages` | Chính. `stream: true` trả SSE đúng chuỗi event Anthropic |
| POST | `/v1/messages/count_tokens` | Ước lượng theo ký tự |
| GET | `/v1/models` | Một model |
| GET/POST | `/effort` | Xem / đổi effort mặc định |
| GET | `/health` | Trạng thái, effort, giới hạn, số session |
| GET | `/debug/sessions` | Các session đang mở, theo variant |
| POST | `/debug/transcript` | Prompt bridge dựng ra (debug) |

Response header, **cả trên streaming path**: `x-bridge-model`, `x-bridge-effort`,
`x-bridge-effort-source`, `request-id`. Trước đây chúng chỉ có ở non-streaming, tức là không
xuất hiện trên bất kỳ request nào Claude Code thực sự gửi. Thêm nữa là `x-should-retry` và
`retry-after` trên lỗi.

Mọi request được ghi một dòng JSON vào `bridge.log` (xoay vòng ở 32 MB, không `statSync` mỗi
dòng để không chặn event loop). Log chỉ ghi **độ dài** của reply bị loại, không ghi nội dung —
nội dung đó thường trích nguyên văn file model sắp đọc. Đặt `BRIDGE_DEBUG=1` để xem nội dung
khi debug cục bộ. Nguyên nhân gốc của mọi lỗi 500 vẫn được ghi đầy đủ.

---

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `BRIDGE_PORT` | `8787` | Port bridge |
| `OC_PORT` | `4599` | Port `opencode serve` |
| `OC_USER` | `opencode` | Username cho Basic auth của serve |
| `OC_PASS` | — | Password của serve; `start-bridge.ps1` tự sinh và lưu vào `.opencode-password` |
| `BRIDGE_MODEL` | `space-bunny-free` | Model trong provider `opencode` |
| `BRIDGE_AGENT` | `ccbridge` | Agent OpenCode cho session |
| `BRIDGE_TIMEOUT` | `900` | Giây chờ upstream trước khi hủy |
| `BRIDGE_TURN_BUDGET_MS` | `240000` | Deadline cho cả một turn, kể cả lượt đầu |
| `BRIDGE_MAX_INFLIGHT` | `4` | Số request đồng thời; vượt thì trả `429` |
| `BRIDGE_EFFORT` | — | Khóa effort cứng, bỏ qua mọi effort của request |
| `BRIDGE_AUX_EFFORT` | — | Effort cho request ngắn: `auxiliary`, `side_reply` |
| `BRIDGE_INPUT_LIMIT` | `524288` | Giới hạn input thật của model |
| `BRIDGE_CONTEXT_LIMIT` | `1048576` | Context window |
| `BRIDGE_OVERHEAD_TOKENS` | `12000` | Phần guard không nhìn thấy (system prompt của OpenCode, retry hints) |
| `BRIDGE_CHARS_PER_TOKEN` | `2.8` | Hệ số ước lượng token khi dựng transcript |
| `BRIDGE_OUT_CHARS_PER_TOKEN` | `3.2` | Hệ số quy đổi `max_tokens` → ngân sách ký tự cho **output** |
| `BRIDGE_TOOL_RESULT_CAP` | `72000` | Ký tự tối đa cho **một** tool result. Claude Code tự tham chiếu 25 000 **token**, tức ~70 000 ký tự; con số cũ 24 000 ký tự là ~8 600 token, chặt gấp 3. |
| `BRIDGE_TOOL_RESULT_BUDGET` | `240000` | Tổng ký tự cho mọi tool result trong một turn; hết ngân sách thì bridge nói rõ thay vì cắt âm thầm |
| `BRIDGE_CLEAR_KEEP_RECENT` | `6` | Số tool result gần nhất được giữ nguyên; cũ hơn thì bị xoá **theo tuổi**, thay bằng một dòng nói rõ gọi lại được |
| `BRIDGE_MAX_ATTEMPTS` | `3` | Số lượt thử tối đa cho một turn |
| `BRIDGE_DEBUG` | — | `1` = ghi kèm nội dung reply bị loại vào log (mặc định chỉ ghi độ dài) |
| `BRIDGE_HEAD_DELAY_MS` | `2500` | Chờ trước khi gửi header SSE |
| `BRIDGE_LOG` | `./bridge.log` | File log |
| `BRIDGE_LOG_MAX_BYTES` | `33554432` | Ngưỡng xoay vòng log |

---

## File

| File | Vai trò |
|---|---|
| `bridge.mjs` | Toàn bộ bridge. Xuất các hàm thuần + `DeferredSSE` cho test |
| `SETTINGS.md` | Từng key của `~/.claude/settings.json` và lý do |
| `claude-settings.example.json` | File settings để sao chép |
| `start-bridge.ps1` / `stop-bridge.ps1` | Bật / tắt, kèm kiểm tra bằng completion thật |
| `claude-bridge.ps1` | Bật bridge rồi mở `claude` |
| `effort.ps1` | Xem / đổi effort mặc định |
| `run-tests.ps1` | Chạy test. Mặc định **không tốn token**; thêm `-Live` cho suite gọi model thật |
| `RESEARCH-tool-call.md` | Contract Anthropic Messages API, đối chiếu mã nguồn `claude.exe` |
| `RESEARCH-opencode-api.md` | Khả năng thật của `opencode serve`: route, permission, structured output |
| `RESEARCH-json-reliability.md` | Structured output, thư viện parse JSON từ LLM, nghiên cứu về model nhỏ |
| `test-unit.mjs` | Hàm thuần: parse, tool, transcript, effort — không cần mạng |
| `test-http.mjs` | Lớp HTTP + `DeferredSSE`, không cần mạng — bắt lỗi status/streaming |
| `test-mock.mjs` | Contract end-to-end với `opencode serve` giả — **miễn phí**, deterministic |
| `probe-behaviour.mjs` | Đo hành vi model thật, **rẻ** (3 tool, ~1.2k token/turn). Báo cáo, không assert |
| `test-sse.mjs` | Hợp đồng streaming end-to-end *(live)* |
| `test-effort.mjs` | Effort end-to-end *(live)* |
| `test-protocol.mjs` | 4 case dễ lỗi protocol *(live)* |
| `test-load.mjs` | Overflow, tool_choice, session, request-class *(live)* |
| `test-bridge.mjs` | Messages API end-to-end |
| `opencode-config/opencode.json` | Config OpenCode riêng (biệt lập qua `OPENCODE_CONFIG_DIR`) |
| `.opencode-password` | Password dùng chung, tự sinh, không commit |

---

## Ghi chú phát hiện trong lúc làm

- Field `tools` (deprecated) **và** `permission` (object) đều gây `FreeTierError`. Chỉ
  `permissions` dạng array chạy ổn định.
- Dù route `/prompt`, `permissions: deny` không chặn được `shell`.
- Endpoint `/api/session/{id}/generate` không có trong tài liệu SDK, phải dò mới ra.
- `/generate` bỏ qua mọi trường đính kèm, kể cả `data:` URI.
- `modelOverrides` làm `/effort` biến mất nếu map sang model chỉ có 4 mức (`claude-sonnet-4-6`).
  `modelPicker.behavesAs` là lời giải sạch hơn.
- Model discovery của Claude Code chỉ nhận id chứa `claude`/`anthropic`, nên
  `space-bunny-free` không hiện trong `/model` discovery; `modelPicker` xử lý chuyện này.
- `agent: "ccbridge"` **set được** trên session, nhưng **không** gỡ được system prompt mà
  `opencode serve` inject. Đo bằng cách hỏi model liệt kê tool của nó, có và không có agent:
  cùng kết quả. Nên đừng kỳ vọng tiết kiệm ~7k token từ đây.
- `/generate` trả `{data:{text}}` và **không có usage**. Vì vậy `input_tokens` /
  `output_tokens` là ước lượng, và `cache_read_input_tokens` luôn bằng 0. Đây là giới hạn
  của route, không phải thiếu sót có thể sửa.
- `opencode serve` yêu cầu Basic auth với username `opencode`. Thiếu tiền tố này thì mọi
  request đều `401` dù đúng mật khẩu — rất dễ chẩn đoán nhầm.