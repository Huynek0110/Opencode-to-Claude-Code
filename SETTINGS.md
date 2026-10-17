# Claude Code settings — mỗi key và lý do

File đang dùng: `%USERPROFILE%\.claude\settings.json`

## Toàn bộ nội dung

```json
{
  "model": "space-bunny-free",

  "modelPicker": {
    "replaceBuiltInOptions": true,
    "options": [
      {
        "model": "space-bunny-free",
        "label": "Space Bunny Free (OpenCode bridge)",
        "description": "Free stealth model, served through opencode serve. Effort: low .. max",
        "behavesAs": "claude-opus-4-7"
      }
    ]
  },

  "modelSettings": {
    "space-bunny-free": {
      "effortLevel": "high",
      "autoCompactWindow": 450000
    }
  },

  "maxEffortLevel": "max",
  "autoCompactWindow": 450000,
  "skipWebFetchPreflight": true,

  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "local-bridge-no-auth",

    "ANTHROPIC_DEFAULT_MODEL": "space-bunny-free",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "space-bunny-free",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "space-bunny-free",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "space-bunny-free",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "space-bunny-free",

    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "32000",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "450000",

    "MAX_MCP_OUTPUT_TOKENS": "25000",
    "BASH_DEFAULT_TIMEOUT_MS": "180000",
    "BASH_MAX_TIMEOUT_MS": "600000"
  }
}
```

## Giải thích từng key

### Định tuyến

| Key | Lý do |
|---|---|
| `ANTHROPIC_BASE_URL` | Trỏ Claude Code vào bridge local. Đây là biến duy nhất Claude Code cần để nói chuyện thay vì `api.anthropic.com`. |
| `ANTHROPIC_AUTH_TOKEN` | Giá trị bất kỳ. Bridge không kiểm tra auth và chỉ bind `127.0.0.1`. Claude Code cần biến này để không đòi login. |
| `ANTHROPIC_DEFAULT_{MODEL,OPUS,SONNET,HAIKU,FABLE}_MODEL` | Mọi alias `/model opus`, `/model sonnet`… đều trỏ về `space-bunny-free`, nên không bao giờ gọi nhầm model Anthropic thật. |

### Model picker

| Key | Lý do |
|---|---|
| `modelPicker.options[0].model` | Model thật sự dùng. |
| `modelPicker.options[0].label` | Tên hiện trong `/model`. Mặc định sẽ hiện `space-bunny-free`, khó đọc. |
| `modelPicker.options[0].description` | Dòng mô tả thứ hai trong picker. |
| `modelPicker.options[0].behavesAs` | **Quan trọng cho effort.** Claude Code chỉ bật thanh effort cho model nó nhận ra. `behavesAs` khiến nó coi `space-bunny-free` như `claude-opus-4-7` — model có đủ `low, medium, high, xhigh, max`. Không có key này thì `/effort` không xuất hiện. |
| `modelPicker.replaceBuiltInOptions` | `true` = chỉ hiện 1 dòng của bridge. Không có nó, picker vẫn liệt kê Opus/Sonnet/Fable thật, chọn vào sẽ ra tên sai. |

> `modelOverrides` (cách cũ tôi thử trước) cũng làm được, nhưng `behavesAs` sạch hơn: giữ được
> tên gốc trong picker, và trường `model` gửi lên wire vẫn là `space-bunny-free`.

### Effort

| Key | Lý do |
|---|---|
| `modelSettings["space-bunny-free"].effortLevel` | Mức mặc định của session = `high`. Claude Code lưu mức đã chọn theo tên model, nên `/effort` sẽ ghi đè key này. |
| `maxEffortLevel` | `"max"` = không chặn mức nào, đủ cả 5 bậc. |
| `modelSettings[...].autoCompactWindow` | 450000 token. Xem phần Context bên dưới. |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Bản env của cùng giá trị, phòng khi `modelSettings` không khớp tên model. |

Các cách chỉnh effort, theo thứ tự ưu tiên Claude Code dùng:

1. `/effort <level>` trong phiên, hoặc `--effort <level>` khi launch
2. `CLAUDE_CODE_EFFORT_LEVEL=<level>` trong shell
3. `effortLevel` trong settings (giá trị ở trên)
4. Effort mặc định của bridge (`POST /effort`), khi request không ghi effort

Các mức: `low`, `medium`, `high`, `xhigh`, `max`.

### Context window

Model thật giới hạn **input 524288 token** (xem `GET /api/model` của `opencode serve`), dù
`context` ghi 1048576. Claude Code không biết con số này nên cần ép tự compact sớm hơn:

| Key | Lý do |
|---|---|
| `autoCompactWindow` | 450000, thấp hơn giới hạn thật để chừa chỗ cho tool result. |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Bản env, Claude Code kẹp giá trị trong khoảng 100000–1000000. |

Nếu không đặt, Claude Code tưởng cửa sổ 1M và sẽ gửi vượt 512K rồi nhận lỗi
"context exceeded".

### Output và payload

| Key | Lý do |
|---|---|
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | 32000. Bridge cắt output theo `max_tokens` và trả `stop_reason: "max_tokens"`, đồng thời tính lại `output_tokens` theo phần thực sự gửi đi. |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | Bỏ các field pre-release mà bridge bỏ qua (`context_management`, `output_config.format`, `task_budget`, tool field beta) → request nhỏ hơn. **Không** ảnh hưởng effort: biến này giữ nguyên `output_config.effort`. |
| `MAX_MCP_OUTPUT_TOKENS` | 25000, tránh tool result MCP nuốt context. |
| `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` | 180s / 600s. Tăng mặc định vì model free thường chậm hơn. |

### Khác

| Key | Lý do |
|---|---|
| `skipWebFetchPreflight` | `true`. Bước kiểm tra an toàn tên miền của WebFetch gọi `api.anthropic.com` — qua gateway thì luôn fail. |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | Cho phép Claude Code hỏi `/v1/models`. Bridge có trả lời; hiện tại id `space-bunny-free` không chứa `claude`/`anthropic` nên bị lọc, nhưng bật vẫn vô hại và sẽ có tác dụng nếu đổi id. |

## Cố tình KHÔNG đặt

| Key | Vì sao |
|---|---|
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Tắt cả auto-update, nên Claude Code sẽ không tự nâng version. Muốn tắt phone-home thì thêm vào, chấp nhận phải update tay. |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | Tắt thinking ⇒ Claude Code báo `Effort '<level>' isn't available with thinking turned off`, tức mất effort. Bridge bỏ qua `thinking` nên không cần. |
| `alwaysThinkingEnabled` | Đây là key để **tắt** thinking. Không bật. |
| `availableModels` / `enforceAvailableModels` | Chỉ có tác dụng trong managed settings, và ở đây chỉ có 1 model nên thừa. |
| `fallbackModel` | Bridge không báo lỗi 529 nên không cần. |
| `modelPricing` | Chỉ đọc từ managed settings. Model free nên không có chi phí để hiển thị. |

## Kiểm tra nhanh

```powershell
# settings có hợp lệ không
claude doctor

# bridge thấy effort gì
Get-Content "C:\Users\Le Hung Lam\Desktop\claude-code-bridge\bridge.log" -Tail 10

# đổi effort mặc định của bridge
powershell -File "C:\Users\Le Hung Lam\Desktop\claude-code-bridge\effort.ps1" max
```