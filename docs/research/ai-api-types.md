# AI API 三类型非流式契约（#73 spike）

调查日期：2026-09-10
调查对象：OpenAI 官方文档（platform.openai.com）+ OpenAI 官方 OpenAPI spec（github.com/openai/openai-openapi）；Anthropic 官方文档（platform.claude.com）+ 官方 TypeScript SDK 源码
关联 issue：#73（本 spike）、#71（wayfinder map）

## 结论

三个 API 都是「一次 POST 拿完整 JSON」的简单契约，纯 `fetch` 各 ~20 行可实现。关键差异在 **base URL 拼法**（OpenAI 含 `/v1`，Anthropic 不含）与**输出文本的 JSON 路径**（三者互不相同）。逐类型契约如下，配置只需存 `{ baseUrl, apiKey, model, type }`。

### 1. OpenAI Responses API（`type: "openai-responses"`）

- **Endpoint**：`POST {baseUrl}/responses`，baseUrl 约定为 `https://api.openai.com/v1`（用户配 baseUrl 时含 `/v1`，客户端拼 `/responses`）。来源：[OpenAI API 认证/概览](https://platform.openai.com/docs/api-reference/introduction)（示例 `curl https://api.openai.com/v1/...`）、[Responses vs Chat Completions 迁移指南](https://platform.openai.com/docs/guides/responses-vs-chat-completions)（`post /v1/responses`）。
- **Auth**：`Authorization: Bearer <api-key>`（OpenAI API 只接受 Bearer 凭证）。来源：[API 认证](https://platform.openai.com/docs/api-reference/introduction)。
- **最小请求体**：`{ "model": "...", "input": "...", "instructions": "..." }`。
  - `model`、`input` 是 spec 里仅有的两个 required 字段；`input` 可以是纯字符串（等价于一条 user 消息），不用构造成 messages 数组。
  - `instructions` 是顶层字段，"Inserts a system (or developer) message as the first item in the model's context"——系统指令走这里，不要塞进 input。
  - 来源：[openai/openai-openapi openapi.yaml](https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml) `CreateResponse` / `ResponseProperties`。
- **输出文本路径**：**HTTP JSON 里没有 `output_text` 字段**——那是 SDK helper（官方指南明确 "The Responses SDK has an `output_text` helper"）。裸 JSON 要自己遍历：`output[]` 中找 `type == "message"` 的 item → 其 `content[]` 中找 `type == "output_text"` → 取 `.text`。注意 reasoning 模型会多出 `type == "reasoning"` 的 item，不能写死 `output[0]`。来源：[迁移指南的响应示例](https://platform.openai.com/docs/guides/responses-vs-chat-completions)、openapi.yaml `Response` schema。
- **错误形状**：`{ "error": { "message", "type", "param", "code" } }`（HTTP 4xx/5xx 时）；另有响应级失败：HTTP 200 但 `status == "failed"` / `"incomplete"`，`error: { code, message }` 或 `incomplete_details.reason == "max_output_tokens" | "content_filter"`。来源：openapi.yaml `ErrorResponse` / `Error` / `ResponseError` schema、[Error codes 指南](https://platform.openai.com/docs/guides/error-codes)。
- **注意项**：`store` 默认 `true`（响应默认存 OpenAI 服务端，关掉传 `store: false`）；`max_output_tokens` 可选，上限随模型变（见 [models 页](https://platform.openai.com/docs/models)，摘要场景设 1024–4096 足够）。来源：openapi.yaml、迁移指南。

### 2. OpenAI Chat Completions API（`type: "openai-chat"`）

- **Endpoint**：`POST {baseUrl}/chat/completions`，baseUrl 同样含 `/v1`（`https://api.openai.com/v1`）。来源：迁移指南（`post /v1/chat/completions`）、[API 认证页示例](https://platform.openai.com/docs/api-reference/introduction)。
- **Auth**：同上，`Authorization: Bearer <api-key>`。
- **最小请求体**：`{ "model": "...", "messages": [{ "role": "system", "content": "..." }, { "role": "user", "content": "..." }] }`。`model` 与 `messages` 是 required。来源：openapi.yaml `CreateChatCompletionRequest`（`required: [model, messages]`）。
  - **"看着可选实则变了"**：`system` 角色仍被接受，但官方 schema 注明 "With o1 models and newer, use `developer` messages for this purpose instead"；推理模型建议用 `role: "developer"`。来源：openapi.yaml `ChatCompletionSystemMessageParam` / `ChatCompletionDeveloperMessageParam`。
- **输出文本路径**：`choices[0].message.content`。来源：[迁移指南](https://platform.openai.com/docs/guides/responses-vs-chat-completions)（"read the model text from `completion.choices[0].message.content`"）、openapi.yaml `ChatCompletion`。
- **错误形状**：与 Responses 相同，`{ "error": { message, type, param, code } }`。
- **弃用状态**：**未弃用、无移除计划**。官方原话："While Chat Completions remains supported, Responses is recommended for all new projects."（Assistants API 才是 2026-08-26 已 sunset 的那个，别混淆。）来源：[Responses vs Chat Completions](https://platform.openai.com/docs/guides/responses-vs-chat-completions)。
- **注意项**：`max_tokens` 参数本身已 deprecated，应传 `max_completion_tokens`（上限随模型变，且"not compatible with o-series models"——o 系/GPT-5 系只认 `max_completion_tokens`）。来源：openapi.yaml `CreateChatCompletionRequest.max_tokens` 描述。

### 3. Anthropic Messages API（`type: "anthropic"`）

- **Endpoint**：`POST {baseUrl}/v1/messages`，baseUrl 约定为 `https://api.anthropic.com`——**不含 `/v1`**，版本段在路径里，客户端拼 `/v1/messages`（官方 SDK 默认 `baseURL = https://api.anthropic.com`）。来源：[Using the API](https://platform.claude.com/docs/en/api/getting-started)、[anthropic-sdk-typescript client.ts](https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/src/client.ts)。
- **Auth + 必传 headers**（三个都 required，裸 fetch 必须全带）：
  - `x-api-key: <key>`（或 `Authorization: Bearer <key>`）；
  - `anthropic-version: 2023-06-01`（required，示例值即 `2023-06-01`，客户端可硬编码）；
  - `content-type: application/json`。
  来源：[Using the API 的 Authentication 表](https://platform.claude.com/docs/en/api/getting-started)。
- **最小请求体**：`{ "model": "...", "max_tokens": 1024, "system": "...", "messages": [{ "role": "user", "content": "..." }] }`。
  - **`max_tokens` 是 required**（"看着可选实则必传"的最大坑：OpenAI 两个 API 都可不传，Anthropic 不传直接 400）。来源：[SDK messages.ts](https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/src/resources/messages/messages.ts) `MessageCreateParamsBase.max_tokens: number`（非 optional）。
  - `system` 是**顶层字段**（optional），不在 `messages` 数组里；`messages` 角色只有 `user`/`assistant`。来源：同上 `system?: string | Array<TextBlockParam>`、[Messages examples](https://platform.claude.com/docs/en/api/messages-examples)。
- **输出文本路径**：`content[]` 中找 `type == "text"` 的块取 `.text`（纯文本场景通常 `content[0].text`，但返回是数组，稳妥写法是 filter/concat）；`stop_reason == "max_tokens"` 表示被截断。来源：[Messages examples 的响应示例](https://platform.claude.com/docs/en/api/messages-examples)。
- **错误形状**：`{ "type": "error", "error": { "type": "...", "message": "..." }, "request_id": "..." }`；HTTP 状态码表：400 `invalid_request_error`、401 `authentication_error`、429 `rate_limit_error`、500 `api_error`、529 `overloaded_error` 等。来源：[Errors 参考](https://platform.claude.com/docs/en/api/errors)。
- **注意项**：非流式大 `max_tokens` 有超时风险（官方警告空闲连接可能被网络中间层掐断；SDK 对非流式请求校验 ≤10 分钟预算）——摘要场景设 1024–4096 即可。当前模型 Max output：Fable 5.1 / Opus 5 / Sonnet 5 = 128K，Haiku 4.5 = 64K，可按模型查 [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)。来源：[Errors 参考的 Long requests 节](https://platform.claude.com/docs/en/api/errors)、Models overview。

## 对实现的设计建议（"base URL + key + model + type" 配置）

1. **baseUrl 语义统一为"原样前缀"**：OpenAI 系用户填 `https://api.openai.com/v1` → 拼 `/responses` 或 `/chat/completions`；Anthropic 填 `https://api.anthropic.com` → 拼 `/v1/messages`。建议客户端对两个 OpenAI type 复用同一 baseUrl，Anthropic 单独一份；尾部 `/` 归一化处理即可。
2. **配置字段**：`{ type: "openai-responses" | "openai-chat" | "anthropic", baseUrl, apiKey, model }` 四项足够；`anthropic-version` 硬编码 `2023-06-01`，不暴露给用户。
3. **max_tokens 策略**：Anthropic 必传，建议默认 2048 或 4096；OpenAI 两个 API 可选（Responses 传 `max_output_tokens`、Chat 传 `max_completion_tokens`），不传则由模型跑完。
4. **文本提取容错**：三种路径分别为——遍历 `output[].content[]` 找 `output_text` / `choices[0].message.content` / `content[]` 找 `type=="text"`；同时检查 OpenAI 的 `status != "completed"` 和 Anthropic 的 `stop_reason == "max_tokens"`。
5. **错误处理**：两个厂商都把错误塞在 `error` 对象里（OpenAI `{message,type,param,code}`，Anthropic `{type:"error",error:{type,message}}`），统一读 `error.message` 展示即可；429/529/5xx 可重试（尊重 `Retry-After`）。

## 附：PDF 文件附件契约（#79，digest 指令 `{{@file}}` 占位符）

调查日期：2026-09-14。三型都支持把 PDF 以 base64 附件加进请求；附件块一律放在文本块之前（Anthropic 官方建议 PDFs before text）。上限取 32 MB（Anthropic 整请求体上限，三型共一档，超出由 executor 降级纯文本）。

- **Responses**：`input` 从纯字符串升级为 user 消息项 `[{ role: "user", content: [{ type: "input_file", filename, file_data: "data:application/pdf;base64,..." }, { type: "input_text", text }] }]`；`instructions` 顶层不变。来源：[OpenAI File inputs 指南](https://platform.openai.com/docs/guides/pdf-files)、openai-dotnet issue [#382](https://github.com/openai/openai-dotnet/issues/382) 的官方示例。
- **Chat Completions**：user 消息 `content` 升级为块数组 `[{ type: "file", file: { filename, file_data: "data:application/pdf;base64,..." } }, { type: "text", text }]`。来源：同上指南、OpenAI 社区[实测请求体](https://community.openai.com/t/base64-file-not-going-through-api/1144263/2)。
- **Messages（Anthropic）**：user 消息 `content` 升级为块数组 `[{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "<裸 base64，无 data: 前缀>" } }, { type: "text", text }]`；`max_tokens` 必传不变。来源：[Claude PDF support 官方文档](https://platform.claude.com/docs/en/build-with-claude/pdf-support)（含 32 MB 请求上限、600 页上限）。

## 证据与复核方式

- OpenAI 文档页（JS 渲染重，"主文本"抽取不完整时）以官方 OpenAPI spec 为准：`curl -sL https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml`，查 `CreateResponse`（required: model, input）、`ResponseProperties.instructions/max_output_tokens`、`Response.status/error/incomplete_details`、`ErrorResponse/Error`、`CreateChatCompletionRequest`（required: model, messages；max_tokens deprecated 文案）。
- Anthropic 文档页同理，请求参数 required 性以官方 SDK 源码为准：`anthropic-sdk-typescript` 的 `src/resources/messages/messages.ts`（`max_tokens: number` required、`system?` optional）与 `src/client.ts`（默认 baseURL）。
- 本次未发真实请求（无双方 API key），全部结论来自文档/规格/第一方源码，未实测。

## 调查限制

- 未用真实 API key 实测三类端点；`status == "failed"` 时 HTTP 是否仍为 200 依据 spec（`Response.error` 定义在 200 响应体内）推断，实现时建议写防御代码同时覆盖两种情况。
- OpenAI 各模型 max output tokens 上限未逐一核对（models 页为 JS 表格），摘要场景 1024–4096 的建议不依赖该精确值。
- Anthropic `anthropic-version` 当前文档示例值为 `2023-06-01`；未来若新模型要求更新版本头，以文档页 Authentication 表为准。
