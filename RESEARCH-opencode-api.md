# Nghiên cứu: khả năng thật của OpenCode server API (v2.0.29)

Ngày dò: 2026-10-17. Máy Windows, `opencode.exe` **v2.0.29** tại
`%APPDATA%\npm\node_modules\@opencode\cli\bin\opencode.exe`.
Server đang chạy: `opencode serve --port 4599 --hostname 127.0.0.1`.

Mức chắc chắn dùng trong file này:

| Nhãn | Nghĩa |
| --- | --- |
| `CAUGHT UP` | Đọc trực tiếp từ schema/tài liệu, hoặc đo bằng cách gọi API thật (không tốn token). |
| `INFERRED` | Suy luận từ bằng chứng đã xác nhận + hành vi đã đọc trong docs, nhưng **chưa** chạy end-to-end có token. |
| `UNVERIFIED` | Chưa biết. Không đoán. |

> **Không có câu trả lời nào ở đây dựa vào prompt thật.** Toàn bộ phép đo dùng
> `GET /openapi.json`, `GET /api/config`, `GET /api/agent`, `GET /api/model`,
> `POST /api/session`, và `POST /api/session/{id}/permission` (endpoint đánh giá
> permission — **không** gọi model). Không route `/generate` hay `/prompt` nào
> được gọi với prompt thật.

---

## 0. TL;DR — phát hiện làm đổi cả bài toán

`permissions: deny` **không** phải vì OpenCode không chặn được `shell`.
Nó là vì **file config của bridge viết sai khoá**, nên **không một rule nào
 được nạp vào cả**. Đây là phát hiện quan trọng nhất của phiên nghiên cứu này.

`opencode-config/opencode.json` dùng khoá `"agent"` (số ít). V2 dùng `"agents"`
(số nhiều). Khi gặp khoá lạ, parser nuốt **toàn bộ object con** vào
`request.body` — tức là đẩy rule permission xuống thành **field JSON gửi thẳng
cho provider**, chứ không phải rule permission.

Đo được trên `GET /api/config` của chính server bridge (port 4599):

```json
"agents": { "ccbridge": {
    "model": { "providerID": "opencode", "model": "space-bunny-free" },
    "request": { "body": {
        "system": "",
        "permissions": [ { "action": "read",  "resource": "*", "effect": "deny" }, ... 23 rule ... ]
    }},
    "description": "...", "mode": "primary"
}}
```

`permissions` nằm trong `request.body`, **không** nằm ở `agent.permissions`.
Và `GET /api/agent` cho thấy agent `ccbridge` đang chạy với ruleset MẶC ĐỊNH:

```json
"id": "ccbridge",
"permissions": [
  { "action": "*", "resource": "*", "effect": "allow" },
  { "action": "read", "resource": "*.env", "effect": "ask" },
  ...
]
```

→ `shell` **allow**. Canary test ghi file `PWNED` là hợp lệ, nhưng nó đo đúng
cái sai.

Khai báo đúng (`agents` + `system` + `permissions`) thì rule vào đúng chỗ
(`CAUGHT UP`, đo trực tiếp):

```json
"agents": { "plur_perm": {
   "system": "SYS", "description": "plural key", "mode": "primary",
   "permissions": [ { "action": "shell", "resource": "*", "effect": "deny" } ] }}
```

Và `POST /api/session/{id}/permission` trả `{"effect":"deny"}` cho `shell`
(`CAUGHT UP`).

**Tệ hơn nữa:** danh sách action của bridge dùng tên V1. Docs V2 nói rõ
*"In V2, use `permissions`, `shell`, and `subagent` instead of `permission`,
`bash`, and `task`"*. Đo được: agent `v1names` (dùng `bash`, `task`, `list`,
`multiedit`, `patch`, `todowrite`, `todoread`, `lsp`, `bashoutput`, `bashkill`)
trả `allow` cho **mọi** action — tên lạ rơi về default `*/* allow`
(`CAUGHT UP`). Nghĩa là kể cả khi sửa khoá, deny list hiện tại vẫn không cắt
được gì.

---

## 1. Route inventory

### 1.1 Nguồn

**CAUGHT UP** — `opencode serve` phục vụ OpenAPI 3.1 spec ở **root**, không phải `/api`:

```
GET http://127.0.0.1:4599/openapi.json     # 276 KB, openapi: "3.1.0", title "opencode HttpApi 0.0.1"
```

Yêu cầu Basic auth (biến môi trường `OPENCODE_PASSWORD` / `OPENCODE_SERVER_PASSWORD`,
username mặc định `opencode`). `/doc` trả HTML shell của SPA, không phải spec —
đừng bị nhầm. 118 path, 285 component schema.

`opencode api <operationId>` cũng dùng spec này (`--help`: *"OpenAPI operation ID,
or an HTTP method followed by a path"*).

### 1.2 Route liên quan tới completion / structured output / tool calling

| Method | Path | operationId | Ghi chú |
| --- | --- | --- | --- |
| POST | `/api/session/{sessionID}/generate` | `session.generate` | Completion thuần. Chỉ nhận `{ prompt }`. |
| POST | `/api/experimental/generate` | `experimental.generate.text` | Stateless, nhận `{ prompt, model? }`. |
| POST | `/api/session/{sessionID}/prompt` | `session.prompt` | Agent loop + tool thật. **Đây là route duy nhất** chạy tool. |
| POST | `/api/session/{sessionID}/synthetic` | `session.synthetic` | Input tổng hợp + agent loop. |
| POST | `/api/session/{sessionID}/shell` | `session.shell` | Chạy 1 lệnh shell trực tiếp (bỏ qua agent loop). |
| GET | `/api/session/{sessionID}/message` | `session.message.list` | Đọc lại message + part (tool call native nằm ở đây). |
| GET | `/api/session/{sessionID}/context` | `session.context` | Message sau lần compact gần nhất. |
| GET | `/api/event` | `event.subscribe` | SSE toàn server. Đường để stream `tool.started` / `tool.completed`. |
| POST | `/api/session/{sessionID}/interrupt` | `session.interrupt` | Dừng turn đang chạy. |
| POST | `/api/experimental/session/{sessionID}/wait` | `experimental.session.wait` | Chờ agent loop idle. |

Route đáng chú ý khác: `/api/session/{id}/permission` (đánh giá permission),
`/api/permission/saved`, `/api/permission/request`, `/api/agent`, `/api/model`,
`/api/provider`, `/api/config`, `/api/mcp`, `/api/pty`, `/api/fs/*`,
`/api/shell`, `/api/vcs/*`, `/api/worktree`, `/api/rpc/{rpcID}/{method}`.

### 1.3 Route **không** tồn tại

**CAUGHT UP** (quét toàn bộ `openapi.json`):

| Đường dẫm | Kết quả |
| --- | --- |
| `response_format` / `responseFormat` | **0 hit** |
| `json_schema` / `jsonSchema` | **0 hit** |
| `structured` (output) | **0 hit** |
| `constrained` decoding | **0 hit** |
| `toolChoice` / `tool_choice` | **0 hit** |
| `disabled_tools` | **0 hit** |
| `cache_control` | **0 hit** |
| `/api/experimental/tool` (V1: list tool + JSON schema) | **không có** trong V2 |

Không có endpoint nào của V2 trả catalog tool kèm JSON schema để client tự dựng
tool call. Tool schema là chi tiết nội bộ của agent loop.

---

## 2. `response_format` / JSON mode

### 2.1 `agent.request.body` — có schema, nhưng V2 **không gửi**

**CAUGHT UP** (schema + docs):

`Config.AgentEncoded.request` = `{ headers?: object<string,string>, body?: object }`,
`body` là object tự do. Docs V2 `/v2/docs/agents`, mục *Request*:

> ⚠️ "The V2 session runner preserves these values but **does not yet send them
> with model requests**. Configure active request settings on the **provider,
> model, or model variant** instead."

Và cuối trang: *"Do not use legacy top-level fields such as `temperature`,
`top_p`, `prompt`, `permission`, `tools`, `disable`, or `maxSteps` in new V2 agent
configuration."*

→ Đường `agent.request.body.response_format` là **đường cụt**. Đây cũng chính là
lý do `system` và `permissions` của config bridge biến mất: chúng rơi vào đúng
cái `request.body` mà V2 giữ lại nhưng không gửi.

### 2.2 `providers.<id>.body` — đường thật

**CAUGHT UP** (docs `/v2/docs/providers`, mục *Requests*):

> "`body` — JSON fields merged into every request body."
> "Use `headers` for additional HTTP headers and `body` for JSON fields that
> should be merged into every request body."

Thứ tự merge: provider → model → variant. `body`/`settings` lồng nhau được merge;
array và scalar thì thay thế.

Schema xác nhận `Config.ProviderEncoded.body: object` (tự do) và
`Config.ModelEncoded` / `Model.Variant` cũng có `body: object`.

Provider `opencode` của máy này (`GET /api/provider/opencode`):

```json
{"id":"opencode","package":"@opencode/ai/providers/openai-compatible",
 "settings":{"apiKey":"public","baseURL":"https://opencode.ai/inference/openai/v1"}}
```

→ **OpenAI-compatible endpoint**. Nên về mặt giao thức, `response_format` là field
hợp lệ để đẩy xuống.

**UNVERIFIED:** `https://opencode.ai/inference/openai/v1` có thực sự tôn trọng
`response_format` không. Không kiểm tra được mà không tốn token. Ba khả năng:
(a) cổng tôn trọng → JSON mode chạy được; (b) cổng bỏ qua field lạ;
(c) cổng trả 400. Docs `/v2/docs/models` cảnh báo chung:
*"Model options are provider-specific. Another provider package may ignore or
reject them."*

### 2.3 Variant cũng mang `body`

**CAUGHT UP.** `Model.Variant` = `{ id, settings, headers, body }`. Cơ chế variant
là thứ **đang hoạt động** cho model này — `/api/model` trả cho
`opencode/space-bunny-free`:

```json
"variants": [
  {"id":"low",    "settings":{"reasoningEffort":"low"}},
  {"id":"medium", "settings":{"reasoningEffort":"medium"}},
  {"id":"high",   "settings":{"reasoningEffort":"high"}},
  {"id":"xhigh",  "settings":{"reasoningEffort":"xhigh"}},
  {"id":"max",    "settings":{"reasoningEffort":"max"}}
]
```

`settings.reasoningEffort` chắc chắn đang được gửi (bridge chọn effort và model
thật sự đổi hành vi). Đó là bằng chứng gián tiếp rằng đường merge của `variant`
hoạt động, nên `variants[].body.response_format` nhiều khả năng cũng được gửi.

### 2.4 Kết luận Q2

| Đường | Trạng thái |
| --- | --- |
| `/generate` + field `response_format` | **CAUGHT UP: không tồn tại** (`additionalProperties: false`, chỉ `{prompt}`) |
| `/prompt` + field `response_format` | **CAUGHT UP: không tồn tại** |
| `agent.request.body.response_format` | **CAUGHT UP: schema có, V2 không gửi** (docs nói thẳng) |
| `providers.opencode.body.response_format` | **CAUGHT UP: đường đúng**; **UNVERIFIED** phía cổng có tôn trọng không |
| `providers.opencode.models["space-bunny-free"].body.response_format` | **CAUGHT UP** qua schema; **UNVERIFIED** phía cổng |
| `providers.opencode.models[...].variants[].body.response_format` | **CAUGHT UP** qua schema + variant đang hoạt động; **UNVERIFIED** phía cổng |

Lưu ý: kể cả khi `response_format` chạy được, nó **không thay thế được** tool
calling. `response_format` ép *text* là JSON hợp lệ; tool calling native vẫn cần
`tools` trong request — mà `/generate` không cho gửi. Hai thứ là hai kênh khác nhau.

---

## 3. Tool calling native — câu hỏi quan trọng nhất

### 3.1 `/prompt` chạy tool thật thế nào

**CAUGHT UP** (schema). `POST /api/session/{id}/prompt` nhận đúng 8 field:

```
id?, text (bắt buộc), files?, agents?, skills?, metadata?, delivery?, resume?
```

`additionalProperties: false`. **Không có** `tools`, **không có** `system`,
**không có** `agent`, **không có** `model`. Không thể truyền tool schema tùy ý
qua request. Tool đến từ agent config + catalog tích hợp sẵn (MCP, plugin).

Model được chọn bằng `POST /api/session/{id}/model` (`Model.Ref`, có `variant`).
Agent được chọn bằng `POST /api/session/{id}/agent` (`{ agent: Agent.ID }`) hoặc
lúc `POST /api/session`.

Tool call native được ghi lại đầy đủ — `Session.Message.Assistant.Tool`:

```
{ type:"tool", id, name, executed: boolean, state: streaming|running|completed|error, time }
```

`state: error` có `error` + `input` (input vẫn được giữ khi bị chặn). Có cả
`providerState` / `providerResultState`. Đây chính là dữ liệu bridge cần để dựng
`tool_use` block chuẩn.

### 3.2 Tắt tool `shell` — ĐÃ TÌM RA CÁCH

Có **hai** đường, cả hai đều đo được bằng endpoint permission (không tốn token).

#### Đường A — `agents.<id>.permissions` trong config

**CAUGHT UP.** Bốn agent thử nghiệm trên một instance probe riêng, đánh giá qua
`POST /api/session/{id}/permission` với `{action, resources:["*"], agent}`:

| Agent (cấu hình) | shell | read | edit | subagent | execute | question |
| --- | --- | --- | --- | --- | --- | --- |
| `plur_perm` — `{action:"shell",...,deny}` | **deny** | allow | allow | allow | allow | allow |
| `catchall` — `{action:"*",resource:"*",deny}` | **deny** | **deny** | **deny** | **deny** | **deny** | **deny** |
| `askall` — `{action:"*",resource:"*",ask}` | ask | ask | ask | ask | ask | ask |
| `v2names` — 12 action V2, tất cả deny | **deny** | **deny** | **deny** | **deny** | **deny** | **deny** |
| `v1names` — 10 action V1 (`bash`,`task`,…) | allow | allow | allow | allow | allow | allow |
| `sing_perm` — dùng khoá `agent` (số ít) | **allow** | allow | — | — | — | — |
| `build` (mặc định, baseline) | allow | allow | allow | allow | allow | allow |

`deny` là **enforcement thật**, không phải metadata: endpoint permission trả về
đúng effect sau khi hệ thống merge base policy → global → agent rules.

Cơ chế merge theo docs `/v2/docs/permissions`:
- Base policy áp cho **mọi** agent, kể cả custom: `*/* allow`, `read *.env ask`,
  `read *.env.* ask`, `read *.env.example allow`.
- Global `permissions` nối tiếp.
- `agents.<id>.permissions` nối tiếp cuối.
- **Rule khớp cuối cùng thắng.**
- Không rule nào khớp → `ask`.
- *"Non-interactive clients must decide how to handle approval requests;
  **configured `deny` rules always remain enforced**."*
- *"Saved approvals are durable, project-scoped `allow` rules. **They never
  override a configured `deny`.**"*

Action V2 hợp lệ (docs): `read`, `edit`, `glob`, `grep`, `shell`, `subagent`,
`skill`, `question`, `webfetch`, `websearch`, `external_directory`,
`<server>_<tool>` (MCP), `opencode_list_mcp_resources`,
`opencode_read_mcp_resource`, `execute`. Không phải action V2: `doom_loop`, `lsp`.

#### Đường B — `permissions` theo từng session qua API (**không cần sửa config**)

**CAUGHT UP** — đây là phát hiện tiện lợi nhất cho bridge.

`POST /api/session` (`session.create`) nhận thêm field `permissions:
Permission.Ruleset`. `PATCH /api/session/{id}` (`session.update`) cũng nhận
`permissions`. Đo trực tiếp:

```
POST /api/session  {"title":"denysess","permissions":[{"action":"*","resource":"*","effect":"deny"}]}
```

rồi đánh giá permission trên session đó (không truyền `agent`):

```
shell=deny  read=deny  edit=deny  subagent=deny  execute=deny  question=deny
```

Và khi truyền `agent:"build"` (agent có `*/* allow` riêng) → vẫn `deny`.

→ Bridge có thể **tạo session `deny-everything` ngay trong code**, không cần
sửa `opencode.json`, không phụ thuộc config, không cần restart `opencode serve`.

#### Cái tôi đã thử và nó **không** hoạt động

| Cách | Kết quả | Mức |
| --- | --- | --- |
| `agent.<id>.permissions` với khoá `agent` số ít | rule bị nuốt vào `request.body` → `allow` | CAUGHT UP |
| Action name V1 (`bash`, `task`, `list`, `patch`, `multiedit`, `todowrite`, `todoread`, `lsp`, `bashoutput`, `bashkill`) | không được nhận diện → `allow` | CAUGHT UP |
| `agent.<id>.tools = { shell:false, bash:false }` | **khoá bị bỏ khỏi config hoàn toàn**, không cảnh báo | CAUGHT UP |
| Top-level `tools` trong config | không có trong `Config.InfoEncoded` của V2 (chỉ tồn tại dạng deprecated kiểu V1 trong schema gộp) | CAUGHT UP |
| `disabled_tools` | không tồn tại trong toàn bộ spec | CAUGHT UP |
| `tool_choice` / `toolChoice` | không tồn tại trong toàn bộ spec | CAUGHT UP |
| `policies: [{action:"tool.use", resource:"shell", effect:"deny"}]` | `build/shell` vẫn `allow`; docs ví dụ dùng resource dạng `"shell:sudo *"` (ghép `action:pattern`) | CAUGHT UP (đường này tôi không xác minh được là hỏng hay chỉ là sai cú pháp resource) |
| Query param / biến môi trường để tắt tool | không có gì trong spec; `serve` chỉ có `--hostname --port --cors --service --stdio` | CAUGHT UP |

#### Điều CHƯA biết: deny có gỡ tool khỏi catalog không

**INFERRED, chưa xác minh.** Có hai hành vi khác nhau tùy loại deny:

- Docs nói rõ `execute` và `browser` bị deny với `*` thì **gỡ khỏi catalog**:
  *"Denying `execute` with resource `*` removes Code Mode and every tool reached
  only through it"*, *"A `browser` deny rule with resource `*` removes the
  browser catalog"*.
- Với tool thường (`read`, `edit`, `shell`…), docs chỉ mô tả nó là **cổng kiểm
  lúc thực thi**: *"Permission: `shell` with each scanner-produced command as a
  resource."* — không nói gỡ khỏi catalog.

Hai dấu hiệu nghiêng về "deny thường = cổng lúc thực thi, tool vẫn còn trong
catalog" (tức là model **vẫn phát ra native tool call**, chỉ là không có gì
chạy):

1. Agent `title` chỉ có `{action:"*",resource:"*",effect:"deny"}`, nhưng system
   prompt của nó vẫn viết *"Never use tools"* — vô nghĩa nếu tools đã bị gỡ.
2. Agent `explore` (deny `*` rồi allow lại `shell`/`read`/`glob`/`grep`/
   `webfetch`/`websearch`/`external_directory`) theo docs là "denies everything
   except…" — mô tả hành vi lúc chạy, không phải catalog rỗng.

**Rủi ro cần loại trừ trước khi chuyển route:** nếu `catchall deny` gỡ **mọi**
tool khỏi catalog, model sẽ không có gì để gọi và quay về trả lời text — tức là
tệ hơn `/generate`. Đây là lý do tôi **không** khuyến nghị `catchall` một cách
mù quáng; hãy dùng deny list tường minh theo tên tool V2 (như `v2names` ở trên,
đã đo là `deny` toàn bộ) rồi chạy một canary turn để xác nhận.

### 3.3 Còn một câu hỏi con chưa rõ

**UNVERIFIED:** tool call bị `deny` thì agent loop có dừng turn hay tiếp tục?
Config schema có `experimental.continue_loop_on_deny` (boolean, **deprecated**):
*"Continue the agent loop when a tool call is denied"*. Mặc định khi bật/tắt
chưa rõ từ docs V2. Nếu mặc định là dừng loop, một tool call bị deny sẽ kết
thúc turn — bridge phải xử lý (coi như turn kết thúc, trả `tool_use` về client
để Claude Code tự chạy tool thật của nó, thì vòng lại với `/prompt`).
Docs `/v2/docs/tools` có: *"A client must support the interactive form"* cho
`question` — nghĩa là client non-interactive có thể **phải** trả lời permission
request qua `POST /api/session/{id}/permission/{requestID}/reply`
(`{ decision: "once"|"always"|"reject" }`). Với `deny` thì không có request nào
được tạo ra, nên đường này chỉ cần cho `ask` và `question`.

---

## 4. `/api/session/{id}/generate` chi tiết

**CAUGHT UP** — request body, từ OpenAPI:

```json
{
  "type": "object",
  "properties": { "prompt": { "type": "string" } },
  "required": ["prompt"],
  "additionalProperties": false
}
```

Response:

```json
{ "data": { "text": "string" } }   // additionalProperties: false
```

Trả về **chỉ có text**. Không `tool_calls`, không `parts`, không `usage`.

Các field bạn hỏi — tất cả **không có**:

| Field | `/generate` | `/prompt` |
| --- | --- | --- |
| `prompt` / `text` | ✅ `prompt` | ✅ `text` |
| `system` | ❌ | ❌ |
| `tools` | ❌ | ❌ |
| `response_format` | ❌ | ❌ |
| `options` | ❌ | ❌ |
| `variant` | ❌ | ❌ (qua `POST /session/{id}/model`) |
| `stop` / `stop_sequences` | ❌ | ❌ |
| `max_tokens` | ❌ | ❌ |
| `temperature` / `top_p` | ❌ | ❌ |
| `model` | ❌ | ❌ (qua `POST /session/{id}/model` hoặc `session.create`) |
| `agent` | ❌ | ❌ (qua `POST /session/{id}/agent` hoặc `session.create`) |

`additionalProperties: false` nghĩa là gửi field lạ sẽ bị **reject**, không phải
bị bỏ qua âm thầm.

**Trong docs không?** `/api/session/{id}/generate` **không** xuất hiện trong
`/docs/server/` (trang đó là tài liệu **V1**, liệt kê `/session/:id/message`,
`/session/:id/prompt_async`, `/global/health`, `/experimental/tool` — những thứ
đã không còn trong V2). Trang V2 tương ứng 404 (`/v2/docs/server` và
`/v2/docs/server/` đều 404 trong ngày 17/10/2026). Endpoint này phải dò ra từ
`/openapi.json` — giống hệt cách người viết bridge tìm ra nó.

**Route anh em:** `POST /api/experimental/generate` — stateless, nhận
`{ prompt, model? }` (`additionalProperties: false`), trả `{ data: { text } }`.
Không có `system`/`tools`/`response_format`; đổi lại không cần session, và nhận
`Model.Ref` (có `variant`) ngay trong body.

---

## 5. Model info — `GET /api/model`

**CAUGHT UP.** Endpoint này cần Basic auth, `/api/config` thì không (bất tiện
khi dò route).

Trường có trong `Model.Info`: `id`, `modelID`, `providerID`, `canonical`,
`family`, `name`, `compatibility`, `package`, `settings`, `headers`, `body`,
`capabilities`, `variants`, `time`, `cost`, `status`, `enabled`, `limit`.

### Có trường nào về tool support / structured output / reasoning?

| Thông tin cần | Có không | Nơi |
| --- | --- | --- |
| Tool support | ✅ `capabilities.tools: boolean` | không có trường "structured output" |
| Input/output modality | ✅ `capabilities.input[]` / `capabilities.output[]` | |
| Reasoning | ✅ gián tiếp qua `variants[].settings.reasoningEffort` và `compatibility.reasoningField` | không có `capabilities.reasoning` ở dạng object trong `Model.Capabilities` của API (chỉ có `tools`/`input`/`output`) |
| Structured output / JSON mode | ❌ **không có trường nào** | toàn spec 0 hit `response_format`/`json_schema`/`structured` |

### `opencode/space-bunny-free` (đo trực tiếp)

```json
{
  "capabilities": { "tools": true, "input": ["text","image","video"], "output": ["text"] },
  "limit":       { "context": 1048576, "input": 524288, "output": 524288 },
  "settings":    { "apiKey": "public", "baseURL": "https://opencode.ai/inference/openai/v1", "provider": "opencode" },
  "compatibility": { "reasoningField": "reasoning_content" },
  "body": {}, "headers": {},
  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },
  "status": "active", "enabled": true,
  "variants": [
    {"id":"low",    "settings":{"reasoningEffort":"low"}},
    {"id":"medium", "settings":{"reasoningEffort":"medium"}},
    {"id":"high",   "settings":{"reasoningEffort":"high"}},
    {"id":"xhigh",  "settings":{"reasoningEffort":"xhigh"}},
    {"id":"max",    "settings":{"reasoningEffort":"max"}}
  ]
}
```

Điểm đáng chú ý:

- **`capabilities.tools: true`** → model hỗ trợ native tool calling. Toàn bộ 10
  model miễn phí của provider `opencode` đều `tools: true`. Việc tool calling bị
  mô phỏng bằng text là **quyết định của bridge**, không phải hạn chế của model.
- `limit.output: 524288` — bridge hiện tự cắt output bằng `max_tokens`; giới hạn
  thật lớn hơn nhiều.
- `variants` = đúng 5 mức effort mà `EFFORT_LEVELS` trong `bridge.mjs` khai báo.
  Khớp hoàn toàn.

---

## 6. Agent config — `opencode.json`

### 6.1 Khoá đúng của V2

**CAUGHT UP** — `Config.InfoEncoded` (V2) các khoá cấp gốc:

```
$schema, shell, model, default_agent, update, share, enterprise, username,
permissions, policies, agents, snapshots, watcher, formatter, lsp, media,
tool_output, mcp, compaction, skills, commands, instructions, references,
websearch, plugins, worktree, warming, providers, experimental
```

Còn trong schema (đều `deprecated: true`): `logLevel`, `server`, `command`,
`reference`, `snapshot`, `plugin`, `autoshare`, `autoupdate`,
`disabled_providers`, `enabled_providers`, `small_model`, `subagent_depth`,
`mode`, **`agent`**, `provider`, `layout`, **`permission`**, **`tools`**,
`attachment`.

`Config.AgentEncoded` (giá trị của `agents.<id>`, `additionalProperties: false`):

```
model, request{headers,body}, system, description, mode, hidden, color,
steps, disabled, permissions
```

**Không có `tools`.** Không có `temperature`. Không có `prompt`. Không có
`permission` (số ít).

### 6.2 Vì sao config hiện tại hỏng — ba lỗi độc lập

`opencode-config/opencode.json` hiện tại:

```jsonc
{ "$schema": "...",
  "agent": {                    // LỖI 1: số ít. V2 là "agents".
    "ccbridge": {
      "mode": "primary",
      "description": "...",
      "system": "",             // LỖI 2 (hậu quả): bị nuốt vào request.body
      "model": "opencode/space-bunny-free",
      "permissions": [ ... ]    // LỖI 3 (hậu quả): bị nuốt vào request.body
    } } }
```

1. **`agent` số ít** → khoá lạ → parser nuốt object con vào `request.body`.
   Đã đo A/B trên hai agent giống nhau, chỉ khác số nhiều/số ít:

   | Agent | `system` | `request.body` | `permissions` hiệu lực |
   | --- | --- | --- | --- |
   | `sing_perm` (`agent`: số ít) | `""` | `{system, permissions}` | **default → shell allow** |
   | `plur_perm` (`agents`: số nhiều) | `"SYS"` | `{}` | **deny shell** |

2. **Tên action V1** (`bash`, `task`, `list`, `multiedit`, `patch`, `todowrite`,
   `todoread`, `lsp`, `bashoutput`, `bashkill`, `bashkill`) → không phải action V2
   → không khớp rule nào → rơi về default `*/* allow`. Đo: agent `v1names` cho
   `allow` ở **mọi** action thử.

3. **Thiếu action V2 quan trọng.** `bash` phải là `shell`; `task` phải là
   `subagent`. `list` không tồn tại (`glob`/`read` phủ). `multiedit`/`patch` nằm
   dưới action `edit`. `todowrite`/`todoread` không còn là action.

Ngoài ra config không có `"$schema"`… không, có. Nhưng nó **không có**
`default_agent`, và `mode: "primary"` là mặc định cho custom agent nên vô hại.

### 6.3 Hình dạng đúng

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "external_directory", "resource": "*", "effect": "deny" }
  ],
  "agents": {
    "ccbridge": {
      "mode": "primary",
      "description": "Raw text completion agent for the Claude Code bridge.",
      "model": "opencode/space-bunny-free",
      "system": "",
      "permissions": [
        { "action": "shell",              "resource": "*", "effect": "deny" },
        { "action": "edit",               "resource": "*", "effect": "deny" },
        { "action": "read",               "resource": "*", "effect": "deny" },
        { "action": "glob",               "resource": "*", "effect": "deny" },
        { "action": "grep",               "resource": "*", "effect": "deny" },
        { "action": "subagent",           "resource": "*", "effect": "deny" },
        { "action": "skill",              "resource": "*", "effect": "deny" },
        { "action": "question",           "resource": "*", "effect": "deny" },
        { "action": "webfetch",           "resource": "*", "effect": "deny" },
        { "action": "websearch",          "resource": "*", "effect": "deny" },
        { "action": "execute",            "resource": "*", "effect": "deny" },
        { "action": "external_directory", "resource": "*", "effect": "deny" }
      ]
    }
  }
}
```

Tương đương markdown agent (docs `/v2/docs/agents`): frontmatter YAML với
`description`, `mode`, `model`, `permissions:`; phần thân file là `system`.

### 6.4 Có khoá nào "xoá tool" được không?

| Khu vực | Kết luận |
| --- | --- |
| `agents.<id>.tools` | **Không tồn tại** trong V2. Đưa vào thì bị **im lặng bỏ khỏi config**, không cảnh báo (`CAUGHT UP`) |
| Top-level `tools` | Không có trong `Config.InfoEncoded` V2; schema gộp chỉ còn dạng deprecated kiểu V1 (`CAUGHT UP`) |
| `agents.<id>.permission` (số ít) | Không có trong `Config.AgentEncoded`; schema gộp chỉ còn dạng deprecated V1 (`CAUGHT UP`) |
| `disabled` | Tắt cả agent, không tắt tool (`CAUGHT UP`) |
| `steps` | *"On the final step, OpenCode removes tools and asks the model to summarize in text."* → bỏ tool ở bước cuối, không phải từ bước 1 (`CAUGHT UP`) |
| `hidden` | Docs nói thẳng: *"This controls visibility, not security. Use permissions to restrict behavior."* (`CAUGHT UP`) |
| `experimental.primary_tools` | Deprecated, và chỉ giới hạn tool cho primary agent (`CAUGHT UP`) |
| **`permissions` deny** | **Đường đúng** (`CAUGHT UP`) |
| **`policies` `tool.use`** | Đường thứ hai, chặn cứng sau rules + saved approvals. Tôi không xác minh được cú pháp resource chính xác (`UNVERIFIED`) |
| **`session.permissions` qua API** | **Đường đúng, không cần config** (`CAUGHT UP`) |

**Không có khoá nào "tắt tool" — chỉ có "từ chối quyền dùng tool".** Khác biệt
này quyết định xem model còn phát ra native tool call hay không; xem §3.2.

---

## 7. Prompt caching

| Câu hỏi | Trả lời | Mức |
| --- | --- | --- |
| `/generate` có dùng cache không? | **Không.** `/generate` không ghi lịch sử session ("Generate **transient** text ... without mutating session history"). Mỗi lần gọi là một completion độc lập, không có prefix ổn định để cache. | CAUGHT UP |
| `cache_control` có trong spec không? | **0 hit** toàn bộ 276 KB `openapi.json`. | CAUGHT UP |
| `Model.CacheFormat` | Enum chỉ có `"anthropic"` \| `"alibaba"`. `space-bunny-free` **không** có trường này trong `compatibility`. | CAUGHT UP |
| `supportsPromptCacheKey` | Có trong `Provider.Compatibility` và `Model.Compatibility`. `space-bunny-free` **không** đặt → không có prompt cache key. | CAUGHT UP |
| `cost.cache` | `{ read: 0, write: 0 }` — có mục cache trong giá, nhưng bằng 0 (free tier). | CAUGHT UP |
| Có cấu hình cache thủ công được không? | `compatibility.cacheFormat` (provider hoặc model). Docs: *"OpenCode places prompt-cache breakpoints **automatically** on routes that are known to need them, such as Anthropic."* Route của `space-bunny-free` là `@opencode/ai/providers/openai-compatible` → không thuộc loại "known to need them". | CAUGHT UP (docs) |
| Provider có hỗ trợ không? | **UNVERIFIED.** Không có tín hiệu nào trong metadata. OpenAI tự cache prefix server-side nên có thể có cache dù client không gửi gì — nhưng gateway `opencode.ai/inference` có làm vậy không thì không đo được mà không tốn token. | UNVERIFIED |

Hệ quả thực tế: dù provider có cache hay không, `/generate` không tạo prefix ổn
định, nên câu chuyện cache hiện tại của `bridge.mjs` (`usage.cacheRead: 0`) là
đúng. `/prompt` có tiềm năng hơn vì session lưu lịch sử thật — nhưng bridge sẽ
phải tự quản lý việc đó.

---

## 8. Hệ quả cho `bridge.mjs`

### 8.1 Điều khẳng định được bằng bằng chứng

1. **Lập luận nền của quyết định hiện tại là sai.** `bridge.mjs` ghi
   (dòng 18–23):
   > *"`POST /api/session/{id}/prompt` cannot guarantee that: config
   > `permission: deny` does not block the shell tool (a canary test had the
   > model write a file containing PWNED)."*

   Canary đó đo đúng, nhưng **không chứng minh điều ghi trong comment**. Nó đo
   một config mà `GET /api/config` cho thấy chưa từng được nạp. Chừng nào
   `agents`/`permissions` còn sai, mọi kết luận về `/prompt` đều không có cơ sở.

2. **Câu trả lời cho Q3 là CÓ.** `/prompt` + tool calling thật **không** bắt
   buộc phải chạm vào máy:
   - Đường config: `agents.<id>.permissions` với tên action V2 → `deny` thật.
   - Đường API: `POST /api/session { permissions: [...] }` → `deny` thật, đo
     được, không cần sửa config.

3. **Model hỗ trợ tool calling.** `capabilities.tools: true`. Việc mô phỏng bằng
   text là lựa chọn của bridge, không phải giới hạn của model hay của API.

4. **`/generate` không thể là tool calling.** `additionalProperties: false`, chỉ
   `{prompt}`; response chỉ `{text}`. Không có đường vòng nào.

5. **Đường JSON mode có thật, nhưng qua provider config, không qua request.**
   `providers.opencode.body` (hoặc `.models[...].body`, `.variants[].body`).
   Phía cổng `opencode.ai/inference/openai/v1` có tôn trọng không thì chưa biết.

### 8.2 Khuyến nghị: chuyển sang `/prompt`

Lập luận từ bằng chứng, không suy đoán:

| Tiêu chí | `/generate` | `/prompt` |
| --- | --- | --- |
| Tool call chuẩn xác | ❌ không có kênh tool (`CAUGHT UP`) | ✅ `Assistant.Tool` có `name`+`input`+`executed` (`CAUGHT UP`) |
| Blocking máy | ✅ theo thiết kế | ✅ **đo được** với `permissions` đúng (`CAUGHT UP`) |
| Retry/narration/narration-detection | ❌ cần cả `RESPONSE_PROTOCOL`, `RETRY_HINTS`, `correctionFor()`, `looksLikeNarration()` (~250 dòng) | ✅ không cần |
| Alias tool name + `INPUT_KEY_MAP` + `DROP_INPUT_KEYS` | ❌ cần cả 3 bảng | ✅ không cần — tên và schema là của OpenCode |
| JSON envelope parsing + 3 lớp validation | ❌ cần | ✅ không cần |
| Prompt size | nhỏ hơn (không có tool catalog) | lớn hơn (tool catalog + system prompt của OpenCode) |
| Rủi ro mới | đã biết | deny có gỡ tool khỏi catalog không → **chưa biết** |

Chi phí trả đổi đã đo được; lợi ích lớn hơn và đã được chứng minh. **Chuyển.**

Nhưng **đừng xoá `/generate` ngay** — nó là fallback và là chứng nhân cho quyết
định. Đề xuất cụ thể:

1. **Sửa `opencode-config/opencode.json`** (`agent` → `agents`, action V1 → V2).
   Không sửa thì mọi thứ dưới đây vô nghĩa.
2. **Thêm một lớp bất biến**: bridge tự tạo session với
   `permissions: [{action:"*",resource:"*",effect:"deny"}]` ngay trong
   `acquireSession()`, không phụ thuộc config. Đây là bảo đảm **theo code** thay
   vì theo file — file có thể lệch, code thì không. Giữ deny-list tường minh
   trong config như lớp thứ hai.
3. **Canary 1 turn, quan sát tool part.** Gọi `/prompt` với một prompt khiến
   model gọi tool, rồi đọc `GET /api/session/{id}/message`. Kiểm ba thứ:
   (a) có `Assistant.Tool` với `executed: false` không → tool vẫn được quảng bá
   (giải quyết §3.2); (b) turn có kết thúc sạch không (giải quyết §3.3);
   (c) không có file nào bị ghi. Tốn đúng một turn.
4. **Chỉ khi canary sạch mới đổi `runModel`.** Song song giữ `/generate` sau
   cờ `BRIDGE_TRANSPORT=generate|prompt`.
5. **Trả tool về Claude Code, không tự chạy.** Khi thấy tool call bị deny,
   bridge dựng `tool_use` block từ `name`+`input` rồi để Claude Code tự dispatch.
   Vòng sau, kết quả tool quay lại `/prompt` như user message. Không cần
   `resolveToolName`/`remapInput`/`validateInput`.
6. **Streaming**: `GET /api/event` (SSE) cho `tool.started`/`tool.completed`;
   `/prompt` trả `200` khi xong (không phải 204 như V1 `prompt_async`).

### 8.3 Việc KHÔNG nên làm

- **Đừng** dùng `agent.request.body` cho `response_format`. V2 giữ nhưng không
  gửi (docs nói thẳng) — sẽ âm thầm không có tác dụng.
- **Đừng** dùng `agent.tools` hoặc top-level `tools`. Im lặng biến mất.
- **Đừng** trông chờ `/generate` nhận thêm field. `additionalProperties: false`
  là hợp đồng.
- **Đừng** tin `/docs/server/`. Đó là tài liệu **V1**, liệt kê route không còn
  tồn tại. Nguồn duy nhất đáng tin là `GET /openapi.json`.

### 8.4 Còn lại câu hỏi nào cần trả lời bằng token

Đúng 3 câu, tất cả đều gọn:

1. `providers.opencode.body.response_format = {"type":"json_object"}` — cổng có
   tôn trọng không? (Q2)
2. Deny thường có gỡ tool khỏi catalog không? (§3.2)
3. Tool call bị deny thì agent loop dừng hay tiếp? (§3.3)

Cả ba đều gộp được vào **một** canary turn duy nhất.

---

## Phụ lục — lệnh dò (chỉ-đọc, không tốn token)

```powershell
# Spec
$pw = (Get-Content .\claude-code-bridge\.opencode-password -Raw).Trim()
$H  = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("opencode:$pw")) }
Invoke-WebRequest http://127.0.0.1:4599/openapi.json -Headers $H -OutFile openapi.json   # 276 KB, 118 path

# Config hiện tại (lộ bug "agent" số ít)
Invoke-WebRequest http://127.0.0.1:4599/api/config -Headers $H
Invoke-WebRequest http://127.0.0.1:4599/api/agent  -Headers $H    # ccbridge.permissions = default, shell allow

# Model
Invoke-WebRequest http://127.0.0.1:4599/api/model   -Headers $H
Invoke-WebRequest http://127.0.0.1:4599/api/provider/opencode -Headers $H

# Đánh giá permission — KHÔNG gọi model, KHÔNG tốn token
$sid = ((irm -Method POST http://127.0.0.1:4599/api/session -Headers $H -ContentType 'application/json' `
        -Body '{"title":"probe","permissions":[{"action":"*","resource":"*","effect":"deny"}]}').data.id)
irm -Method POST "http://127.0.0.1:4599/api/session/$sid/permission" -Headers $H -ContentType 'application/json' `
    -Body '{"action":"shell","resources":["*"]}'
# -> {"data":{"id":"per_...","effect":"deny"}}
```

Instance probe dùng để A/B `agent` vs `agents` chạy ở port 4611 với
`OPENCODE_CONFIG_DIR` trỏ vào thư mục tạm, đã tắt và xoá sau khi đo. Server của
người dùng ở 4599 không bị đụng vào.

## Phụ lục — nguồn

| Nguồn | URL |
| --- | --- |
| OpenAPI spec (chính thức, chạy trên máy) | `http://127.0.0.1:4599/openapi.json` |
| Config schema (V2 + V1 deprecated) | https://opencode.ai/config.json |
| Docs V2 — Permissions | https://opencode.ai/v2/docs/permissions |
| Docs V2 — Agents | https://opencode.ai/v2/docs/agents |
| Docs V2 — Tools | https://opencode.ai/v2/docs/tools |
| Docs V2 — Providers | https://opencode.ai/v2/docs/providers |
| Docs V2 — Models | https://opencode.ai/v2/docs/models |
| Docs V1 — Server (**lỗi thời**) | https://opencode.ai/docs/server/ |
| `opencode --help`, `serve --help`, `api --help` | cục bộ |

`https://opencode.ai/v2/docs/server` và `/v2/docs/server/` → **404** trong ngày
17/10/2026. `/api/session/{id}/generate` không có mặt trong bất kỳ trang docs nào
phải dò từ spec.