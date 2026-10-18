# Nội dung system prompt mà `opencode serve` inject

Ghi bằng cách **đọc trực tiếp binary** `opencode.exe` (213 MB) trên máy, không gọi model,
không tốn token:

```
%APPDATA%\npm\node_modules\@opencode\cli\bin\opencode.exe
```

Phương pháp: nạp binary, `toString("latin1")`, tìm chuỗi đích, rồi nới trái–phải tới khi gặp
byte không in được để lấy đúng một "printable run". Mọi trích dẫn dưới đây là văn bản
nguyên văn trong binary.

Mức chắc chắn: **CAUGHT UP** = đọc trực tiếp từ binary. **INFERRED** = suy luận từ đó.

---

## 1. `edit` — nguyên văn

Trích từ offset ~100 233 244:

> Edit the contents of a file by finding and replacing exact text. When editing
> text from Read output, preserve the exact indentation (tabs or spaces) and omit
> the line-number prefix, such as `1: `. Never include the prefix in oldString or
> newString. Write line breaks as \n; the file's existing CRLF or LF line endings
> are matched and preserved. To change line endings themselves, make oldString and
> newString differ only in \r; that edit applies to the exact bytes. If there is no
> exact match, the edit retries while ignoring typographic quote, dash, and space
> variants, then trailing whitespace on each line. The edit fails if oldString is
> not found. **By default, oldString must identify a UNIQUE location. Multiple
> matches FAIL unless replaceAll is true.** Add more surrounding context to
> disambiguate, or **set replaceAll to true to replace every occurrence**. Use
> replaceAll when the change should apply to every occurrence, such as renaming a
> variable.

**Đây là câu gây hại rõ ràng nhất tìm được.** OpenCode không chỉ dùng `replaceAll`, nó
**dạy model dùng** nó, bằng hai lần, trong mô tả tool. Claude Code dùng `replace_all` và schema
đóng (`additionalProperties: false` mọi object).

Không map `replaceAll` → `replace_all` thì: `Edit` sửa **một** lần thay vì **tất cả** — và
không có lỗi nào báo ra. Đây là lỗi im lặng đắt nhất bridge từng có.

→ `bridge.mjs` `INPUT_KEY_MAP.Edit`: `replaceAll` → `replace_all`. **Đã sửa, có test.**

## 2. `subagent` — nguyên văn

Trích từ offset ~100 190 658:

> The `subagent` tool takes `agent` instead of `subagent_type` and `sessionID`
> instead of `task_id`.

Câu này là một chú thích **tương thích Claude Code** nằm ngay trong mô tả của chính OpenCode:
OpenCode biết tên field của Claude Code là gì và chủ động đổi tên để không nhận nhầm.

Hai hệ quả:

- OpenCode quảng bá `subagent` (không chỉ `task`). Bảng alias của bridge trước đây **bỏ sót**
  `subagent`, nên model làm đúng theo mô tả này sẽ bị từ chối và đốt một lượt retry.
- `agent` phải map sang `subagent_type` của Claude Code.

→ **Đã sửa:** `TOOL_ALIASES.subagent → ["Task"]`, `INPUT_KEY_MAP.Task: { agent: "subagent_type" }`.

## 3. Field không tồn tại

`workdir` xuất hiện trong binary như một **chuỗi đứng riêng 7 ký tự** (offset ~98 260 824) —
tức nó là tên field trong schema, không nằm trong prose nào. Claude Code không có field này
trên `Bash`, và schema của Claude Code đóng.

→ `DROP_INPUT_KEYS.Bash` gồm `workdir`. **Đã có từ vòng trước.**

---

## Điều chưa lấy được — nói thẳng thay vì suy đoán

Agent nghiên cứu được giao nhiệm vụ này đã **dính rate limit** và không hoàn tất. Tôi tự làm
lại bằng cách đọc binary, kết quả trên đây là phần xác minh được. Những mục sau **chưa** xác
minh, và tôi không đoán:

| Cần xác minh | Trạng thái |
|---|---|
| Mô tả đầy đủ của `bash`, `read`, `write`, `grep`, `glob`, `list`, `webfetch`, `todowrite`, `skill`, `question` | **CHƯA LẤY ĐƯỢC** |
| Một đoạn prose nào trong prompt khuyến khích model **giải thích trước khi hành động** (nguyên nhân gốc của lỗi narration) | **CHƯA XÁC MINH** |
| Tên tool nào thực sự được đăng ký trong bản build này | **CHƯA XÁC MINH** (chỉ có danh sách từ reviewer đọc binary, không tự kiểm lại) |

**Vì sao không lấy được:** mô tả tool nằm ở các vùng binary khác nhau, mỗi vùng xen kẽ dữ liệu
nhị phân; công cụ này lấy được "printable run" khi chuỗi đích nằm trong một vùng in liên tục
(đúng với `edit`), nhưng các vùng còn lại phân tán hơn và cần công cụ khác.

---

## `question` — suy luận, chưa xác minh

OpenCode đăng ký tool `question` (theo danh sách reviewer đọc được từ binary). Claude Code có
`AskUserQuestion` (có `AskUserQuestionInput` trong `sdk-tools.d.ts` của Claude Code, đã xác minh
ở `RESEARCH-tool-call.md`).

→ Bridge đã map `question` → `AskUserQuestion`. **Mức chắc chắn: INFERRED** — cần một lần đo
thực tế mới xác nhận tên tool mà model thật sự dùng. Rủi ro thấp: alias chỉ có tác dụng khi
client thực sự cung cấp `AskUserQuestion`, nếu không thì hành vi cũ giữ nguyên.

---

## Hệ quả cho `bridge.mjs`

| Việc | Trạng thái |
|---|---|
| `Edit.replaceAll` → `replace_all` | Đã sửa (vòng 5), xác minh bằng mô tả gốc ở đây |
| `subagent` → `Task`, kèm `agent` → `subagent_type` | **Đã sửa ở vòng 7** |
| `question` → `AskUserQuestion` | **Đã sửa ở vòng 7** (INFERRED) |
| `bash.workdir` bị bỏ | Đã có |
| `grep.caseSensitive` bị bỏ | Đã có (`-i` nghịch đảo chiều, không map được) |
| `glob.hidden` / `glob.limit` bị bỏ | Đã có |

**Bài học phương pháp:** đọc mô tả tool gốc tốn **0 token** và cho dữ liệu chính xác hơn hỏi
model — hỏi model sẽ tốn tiền và câu trả lời có thể bịa. Với một hệ thống mà chi phí mỗi
lượt là hàng chục nghìn token, đây là phép đo rẻ nhất có sẵn.