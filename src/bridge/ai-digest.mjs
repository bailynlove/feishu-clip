import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// AI 摘要（#75）：用户在 Bridge 上配置一个 AI API（responses / chat-completions / messages
// 三型，契约事实见 docs/research/ai-api-types.md），clip 管线在建档前调用它生成摘要。
// API key 只存在于 ai.json（本模块的 AiConfigStore），绝不进 chrome.storage，也不从任何端点返回
export const AI_API_TYPES = Object.freeze(['responses', 'chat-completions', 'messages']);

// 各类型默认 baseUrl：OpenAI 两型含 /v1（客户端拼 /responses、/chat/completions）；
// Anthropic 不含版本段（客户端拼 /v1/messages）——拼法差异是契约事实，勿「统一」
export const AI_DEFAULT_BASE_URL = Object.freeze({
  responses: 'https://api.openai.com/v1',
  'chat-completions': 'https://api.openai.com/v1',
  messages: 'https://api.anthropic.com',
});

// 内置默认 180s：reasoning 模型（glm-5.3-flash 等）思考也耗时，60s 对慢 provider 太紧；
// 用户可在「高级设置」按 provider 覆盖（config.timeoutMs）
export const AI_TIMEOUT_MS = 180_000;
export const AI_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const AI_MAX_INPUT_CHARS = 100_000;
export const AI_MAX_OUTPUT_TOKENS = 2048;
// maxOutputTokens 选填上限：reasoning 模型（gpt-5 系/o 系）reasoning 也烧 output tokens，
// 默认 2048 可能不够，用户可在「高级设置」调高；上限防手滑
export const AI_MAX_OUTPUT_TOKENS_LIMIT = 128_000;
// timeoutMs（高级设置）选填范围：5–1800 秒（毫秒整数）；下限防误配成秒数，上限防手滑
export const AI_TIMEOUT_MS_MIN = 5_000;
export const AI_TIMEOUT_MS_LIMIT = 1_800_000;

// {{@file}} 占位符（#79）：指令中检出即把本次剪藏的 PDF 以 base64 附件加进 AI 请求。
// 附件上限 32 MB 对齐 Anthropic 请求体上限（三型共一档）；超出由 executor 降级为纯文本摘要
export const AI_FILE_MAX_BYTES = 32 * 1024 * 1024;
// 内置默认摘要指令：与 src/extension/presets.js 的 DEFAULT_DIGEST_INSTRUCTION 同一份——
// SW 与 bridge 分属两个运行时，无法共享模块，修改须两边同步
export const DEFAULT_DIGEST_INSTRUCTION = '请用与正文相同的语言，把以下网页正文总结为 3-6 条要点，每条一句话，直接输出要点列表，不要输出额外解释。';

const FILE_PLACEHOLDER = /\{\{\s*@file\s*\}\}/;

export function hasFilePlaceholder(instruction) {
  return FILE_PLACEHOLDER.test(String(instruction ?? ''));
}

// 剥除 {{@file}}（全部出现，含空格写法）；剥完为空白时回落内置默认（与扩展侧解析兜底同一份）。
// 无占位符时原样返回——不动 trim，保证无 {{@file}} 指令的请求体与既有行为逐字节一致
export function stripFilePlaceholder(instruction) {
  const text = String(instruction ?? '');
  if (!FILE_PLACEHOLDER.test(text)) return text;
  const stripped = text.replace(new RegExp(FILE_PLACEHOLDER.source, 'g'), '').trim();
  return stripped || DEFAULT_DIGEST_INSTRUCTION;
}

const AI_LIMITS = Object.freeze({
  baseUrlChars: 300,
  modelChars: 128,
  apiKeyChars: 512,
  headerCount: 20,
  headerNameChars: 64,
  headerValueChars: 1024,
});

function aiError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

// ——— 请求构造器（每型 ~20 行）：认证方式与请求体形状按类型各自的契约；stream 开关流式（#86） ———

// pdf 附件（#79）：{ filename, dataBase64 }，null 表示纯文本摘要（请求体与现状完全一致）。
// OpenAI 两型走 base64 data URL 的 file 输入块；Anthropic 走 document 块（data 为裸 base64）
function pdfDataUrl(pdf) {
  return `data:application/pdf;base64,${pdf.dataBase64}`;
}

const REQUEST_BUILDERS = {
  // OpenAI Responses：instructions 是顶层系统指令字段，input 可以是纯字符串；
  // store:false 关闭服务端留存；max_output_tokens 是这型的上限字段。
  // config.headers（高级设置的自定义请求头）最后展开：可追加路由头（如 opencode-go 的
  // x-opencode-session），也可覆盖默认头（特殊网关改认证方案场景）——三型同一约定。
  // 带附件时 input 升级为 user 消息项：input_file 块（filename + file_data data URL）在文本前。
  // stream（#86）：流式加 stream:true（SSE 事件：response.output_text.delta 等）
  responses(config, instruction, content, maxOutputTokens, pdf = null, stream = false) {
    return {
      url: `${trimTrailingSlash(config.baseUrl)}/responses`,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', ...config.headers },
      body: {
        model: config.model,
        instructions: instruction,
        input: pdf
          ? [{ role: 'user', content: [
            { type: 'input_file', filename: pdf.filename, file_data: pdfDataUrl(pdf) },
            { type: 'input_text', text: content },
          ] }]
          : content,
        store: false,
        max_output_tokens: maxOutputTokens,
        // reasoning 三态（#96）：开 → effort medium；关 → effort low（OpenAI 文档另有
        // none/minimal 但仅部分模型系列支持，无法运行时验证，关用保守的 low）；
        // 默认（未配置）不发 reasoning 参数，跟随服务端默认
        ...(config.reasoning ? { reasoning: { effort: config.reasoning === 'on' ? 'medium' : 'low' } } : {}),
        ...(stream ? { stream: true } : {}),
      },
    };
  },
  // OpenAI Chat Completions：max_tokens 已废弃，必须用 max_completion_tokens；
  // 带附件时 user 消息 content 升级为块数组：file 块（file.file_data data URL）在文本前。
  // stream（#86）：stream:true + stream_options.include_usage 要求末帧带 usage（OpenAI 惯例；
  // GLM/DeepSeek 等兼容端点不支持时会省略 usage 帧，消费侧按缺失容忍，回落近似计数）
  'chat-completions': (config, instruction, content, maxOutputTokens, pdf = null, stream = false) => ({
    url: `${trimTrailingSlash(config.baseUrl)}/chat/completions`,
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', ...config.headers },
    body: {
      model: config.model,
      messages: [
        { role: 'system', content: instruction },
        pdf
          ? { role: 'user', content: [
            { type: 'file', file: { filename: pdf.filename, file_data: pdfDataUrl(pdf) } },
            { type: 'text', text: content },
          ] }
          : { role: 'user', content },
      ],
      max_completion_tokens: maxOutputTokens,
      // reasoning 三态（#96）：GLM/DeepSeek 惯例 thinking.type。chat-completions 无法静态区分
      // GLM 与 OpenAI 兼容端点（后者用 reasoning_effort）——本项目用户实际在用 GLM，取 GLM 惯例；
      // 接 OpenAI 兼容端点的用户请保持默认（不发参数），不走 reasoning_effort
      ...(config.reasoning ? { thinking: { type: config.reasoning === 'on' ? 'enabled' : 'disabled' } } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    },
  }),
  // Anthropic Messages：max_tokens 必填；system 是顶层字段不在 messages 里；
  // anthropic-version 为必传头，硬编码当前文档示例值。
  // 带附件时 user content 升级为块数组：document 块（base64 source，data 为裸 base64）在文本前。
  // stream（#86）：流式加 stream:true（SSE 事件：content_block_delta 的 text_delta/thinking_delta 等）
  messages(config, instruction, content, maxOutputTokens, pdf = null, stream = false) {
    return {
      url: `${trimTrailingSlash(config.baseUrl)}/v1/messages`,
      headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', ...config.headers },
      body: {
        model: config.model,
        max_tokens: maxOutputTokens,
        system: instruction,
        messages: [{
          role: 'user',
          content: pdf
            ? [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.dataBase64 } },
              { type: 'text', text: content },
            ]
            : content,
        }],
        // reasoning 三态（#96）：开 → 扩展思考 enabled + budget（Anthropic 要求 budget_tokens
        // 严格小于 max_tokens，故按当前 maxOutputTokens 收敛，上限 8192；maxOutputTokens ≤1024
        // 时 provider 会拒绝，交给既有错误通道呈现）；关/默认 → 省略 thinking 字段
        ...(config.reasoning === 'on' ? { thinking: { type: 'enabled', budget_tokens: Math.min(8192, maxOutputTokens - 1) } } : {}),
        ...(stream ? { stream: true } : {}),
      },
    };
  },
};

// ——— 响应提取器：三型的文本 JSON 路径互不相同（契约事实） ———

// HTTP JSON 里没有顶层 output_text（那是 SDK helper）：要自己遍历 output[] 找
// type=="message" 的 item，再在其 content[] 里找 type=="output_text" 取 .text；
// reasoning 模型会多出 type=="reasoning" 的 item，不能写死 output[0]。
// HTTP 200 但 status=="failed"/"incomplete" 是响应级失败，按失败处理
function extractResponsesText(payload) {
  if (payload?.status === 'failed' || payload?.status === 'incomplete') {
    const reason = payload?.error?.message || payload?.incomplete_details?.reason || payload.status;
    throw aiError('AI_REQUEST_FAILED', `AI 响应未成功（${reason}）`);
  }
  for (const item of payload?.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const part of item?.content ?? []) {
      if (part?.type === 'output_text' && typeof part?.text === 'string') return part.text;
    }
  }
  throw aiError('AI_REQUEST_FAILED', 'AI 响应中没有文本输出');
}

function extractChatCompletionsText(payload) {
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw aiError('AI_REQUEST_FAILED', 'AI 响应中没有文本输出');
  return text;
}

// 返回是 content 块数组，稳妥写法是拼接全部 type=="text" 块的 .text
function extractMessagesText(payload) {
  const text = (payload?.content ?? []).filter((block) => block?.type === 'text' && typeof block?.text === 'string')
    .map((block) => block.text)
    .join('\n');
  if (!text) throw aiError('AI_REQUEST_FAILED', 'AI 响应中没有文本输出');
  return text;
}

const EXTRACTORS = {
  responses: extractResponsesText,
  'chat-completions': extractChatCompletionsText,
  messages: extractMessagesText,
};

// ——— 流式消费（#86）：三型统一走 SSE delta，为实时进度供数 ———

// 近似 token 计数：不引入 tokenizer——CJK/假名/谚文/全角按 1 字符 ≈ 1 token，
// 其余非空白字符按 ~4 字符/token 折算。只用于进度展示，流结束时以 provider usage 校准
function approxTokens(text) {
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (/[぀-ヿ가-힯一-鿿豈-﫿＀-￯]/.test(ch)) wide += 1;
    else narrow += 1;
  }
  return wide + Math.ceil(narrow / 4);
}

// SSE 帧读取：事件以空行分隔；data: 多行按 \n 拼接；event: 行给出类型（Anthropic 惯例，
// OpenAI 不带 event 行——类型在 data.type 里）；':...' 是注释/心跳行，忽略。
// 增量解码（TextDecoder stream 模式）保证多字节字符被切断在两块之间也不乱码；
// 响应体沿用 4 MiB 上限。body 不可异步迭代（测试 fake 只给 text()）时整读后按单块解析
async function readSse(response, onEvent) {
  const decoder = new TextDecoder();
  const iterable = response.body?.[Symbol.asyncIterator]
    ? response.body
    : (async function* () { yield Buffer.from(await response.text()); })();
  let pending = '';
  let bytes = 0;
  let eventType = '';
  let dataLines = [];
  const dispatch = () => {
    if (!eventType && dataLines.length === 0) return;
    onEvent({ event: eventType, data: dataLines.join('\n') });
    eventType = '';
    dataLines = [];
  };
  const takeLine = (raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') { dispatch(); return; }
    if (line.startsWith(':')) return;
    if (line.startsWith('event:')) { eventType = line.slice('event:'.length).trim(); return; }
    if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
  };
  for await (const chunk of iterable) {
    bytes += chunk.byteLength ?? Buffer.byteLength(chunk);
    if (bytes > AI_MAX_RESPONSE_BYTES) throw aiError('AI_REQUEST_FAILED', 'AI 响应超过大小上限');
    pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      takeLine(pending.slice(0, index));
      pending = pending.slice(index + 1);
    }
  }
  pending += decoder.decode();
  if (pending) takeLine(pending);
  dispatch();
}

// 流式状态机：每个 delta 调 onProgress({ phase, tokens })（executor 纯内存赋值，禁 I/O）。
// phase：reasoning delta → 'thinking'，正文 delta → 'writing'；tokens 是当前相位的近似累计
// （thinking 相位也计数，#97）。终止帧带 provider usage 时校准最终计数（responses:
// response.completed 的 usage.output_tokens；chat-completions: 末帧 usage.completion_tokens；
// messages: message_delta 的 usage.output_tokens）；usage 带 reasoning/thinking 字段时
// 另发一帧思考校准（先于正文校准），缺省保留近似值不发帧
function makeStreamConsumer(apiType, onProgress) {
  const state = { text: '', tokens: 0, reasoningTokens: 0, phase: 'thinking', usageTokens: null, usageReasoningTokens: null, terminal: null, sawTextBlock: false };
  const emit = () => onProgress?.({ phase: state.phase, tokens: state.phase === 'thinking' ? state.reasoningTokens : state.tokens });
  const writeText = (delta) => { state.phase = 'writing'; state.text += delta; state.tokens += approxTokens(delta); emit(); };
  const writeReasoning = (delta) => { state.phase = 'thinking'; state.reasoningTokens += approxTokens(delta); emit(); };
  const streamError = (data) => { throw aiError('AI_REQUEST_FAILED', data?.message ?? data?.error?.message ?? 'AI 响应流式错误'); };

  const onEvent = (eventType, data) => {
    // OpenAI 两型类型在 data.type（通常无 event 行）；Anthropic 类型在 event 行（data.type 同值兜底）
    const type = eventType || data?.type || '';
    if (apiType === 'responses') {
      if (type === 'response.output_text.delta' && typeof data.delta === 'string') writeText(data.delta);
      // reasoning_summary_text.delta 是官方文档的摘要推理 delta；reasoning_text.delta 是
      // openai-python SDK 里更新的原始推理 delta（部分模型/代理发这个），都算 thinking
      else if ((type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') && typeof data.delta === 'string') writeReasoning(data.delta);
      else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
        state.terminal = data.response ?? null;
        if (Number.isFinite(data.response?.usage?.output_tokens)) state.usageTokens = data.response.usage.output_tokens;
        // reasoning_tokens 细分（#97）：OpenAI 放在 output_tokens_details 里
        const reasoningTokens = data.response?.usage?.output_tokens_details?.reasoning_tokens;
        if (Number.isFinite(reasoningTokens)) state.usageReasoningTokens = reasoningTokens;
      } else if (type === 'error') streamError(data);
      return;
    }
    if (apiType === 'chat-completions') {
      const delta = data?.choices?.[0]?.delta;
      // 空串 delta（首帧 role-only 等）不算正文，不翻转相位
      if (typeof delta?.content === 'string' && delta.content) writeText(delta.content);
      // reasoning_content 是 GLM/DeepSeek 惯例的推理 delta 字段
      if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) writeReasoning(delta.reasoning_content);
      if (Number.isFinite(data?.usage?.completion_tokens)) state.usageTokens = data.usage.completion_tokens;
      // reasoning_tokens 细分（#97）：GLM/OpenAI 兼容端点放在 completion_tokens_details 里
      const reasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens;
      if (Number.isFinite(reasoningTokens)) state.usageReasoningTokens = reasoningTokens;
      if (type === 'error') streamError(data);
      return;
    }
    // messages（Anthropic）：text_delta 正文、thinking_delta 推理；
    // 多个 text 块之间补 '\n' 分隔——与非流式 extractMessagesText 的拼接口径一致
    if (type === 'content_block_start' && data?.content_block?.type === 'text') {
      if (state.sawTextBlock) state.text += '\n';
      state.sawTextBlock = true;
    } else if (type === 'content_block_delta' && data?.delta?.type === 'text_delta' && typeof data.delta.text === 'string') {
      writeText(data.delta.text);
    } else if (type === 'content_block_delta' && data?.delta?.type === 'thinking_delta' && typeof data.delta.thinking === 'string') {
      writeReasoning(data.delta.thinking);
    } else if (type === 'message_delta') {
      if (Number.isFinite(data?.usage?.output_tokens)) state.usageTokens = data.usage.output_tokens;
      // 思考计数细分（#97）：标准 Anthropic usage 无 thinking 字段；部分网关附 thinking_tokens，容忍读取
      if (Number.isFinite(data?.usage?.thinking_tokens)) state.usageReasoningTokens = data.usage.thinking_tokens;
    } else if (type === 'error') {
      streamError(data);
    }
  };

  // 终止口径与非流式等价：responses 有终止帧时以帧内 response 对象为准（status 是
  // incomplete/failed 时 extractResponsesText 按既有语义抛 AI_REQUEST_FAILED）；
  // 无终止帧（代理截断事件流）回落 delta 累计文本；空文本与非流式同一句报错。
  // 返回前用 provider usage 校准最终计数：思考计数优先取 reasoning/thinking 细分字段（#97），
  // 正文照旧取 output/completion tokens；字段缺失保留近似值（不发校准帧）
  const finalize = () => {
    const text = state.terminal ? extractResponsesText(state.terminal) : state.text;
    if (!text) throw aiError('AI_REQUEST_FAILED', 'AI 响应中没有文本输出');
    if (Number.isFinite(state.usageReasoningTokens)) onProgress?.({ phase: 'thinking', tokens: state.usageReasoningTokens });
    if (Number.isFinite(state.usageTokens)) onProgress?.({ phase: 'writing', tokens: state.usageTokens });
    return text;
  };

  return { onEvent, finalize };
}

async function consumeStream(response, apiType, onProgress, signal) {
  const consumer = makeStreamConsumer(apiType, onProgress);
  try {
    await readSse(response, ({ event, data }) => {
      if (data === '[DONE]') return; // OpenAI 两型的流终止哨兵
      let payload;
      try { payload = JSON.parse(data); } catch { throw aiError('AI_REQUEST_FAILED', 'AI 响应流数据不是合法 JSON'); }
      consumer.onEvent(event, payload);
    });
  } catch (error) {
    if (signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw aiError('AI_TIMEOUT', 'AI 请求超时');
    }
    throw error;
  }
  return consumer.finalize();
}

// 响应体上限 4 MiB：流式读（fetch 的 Response.body 在 Node 里可异步迭代），超限即弃；
// 无 body（测试 fake 只给 text()）时回退整读后再卡上限
async function readBodyText(response) {
  if (response.body?.[Symbol.asyncIterator]) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > AI_MAX_RESPONSE_BYTES) throw aiError('AI_REQUEST_FAILED', 'AI 响应超过大小上限');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > AI_MAX_RESPONSE_BYTES) throw aiError('AI_REQUEST_FAILED', 'AI 响应超过大小上限');
  return text;
}

// 非 2xx：两个厂商都把错误塞在 error 对象里，统一读 error.message；非 JSON 错误体取原文，≤300 字符
function extractErrorDetail(text) {
  try {
    const payload = JSON.parse(text);
    const message = payload?.error?.message ?? payload?.message;
    if (typeof message === 'string' && message) return message.slice(0, 300);
  } catch { /* 非 JSON 错误体，取原文 */ }
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function httpErrorCode(status) {
  if (status === 401 || status === 403) return 'AI_AUTH_FAILED';
  if (status === 429) return 'AI_RATE_LIMITED';
  return 'AI_REQUEST_FAILED';
}

// 正文超过 100_000 字符截断，末尾附一行截断说明
function truncateInput(content) {
  const text = String(content ?? '');
  if (text.length <= AI_MAX_INPUT_CHARS) return text;
  return `${text.slice(0, AI_MAX_INPUT_CHARS)}\n\n（正文过长，已截断）`;
}

// fetchImpl 可注入（测试不走网络）；maxOutputTokens/timeoutMs 显式参数（测试连通性探针与超时测试）
// 优先，其次 config 里的高级设置，最后内置默认（2048 / AI_TIMEOUT_MS 180s）。
// pdf（#79）：{{@file}} 附件 { filename, dataBase64 }，由 executor 检出占位符并下载后传入；
// 占位符剥除与空指令兜底在这里统一做，无论附件是否随请求发出。
// stream（#86）默认 true：三型统一走 SSE 流式，onProgress({ phase, tokens }) 逐 delta 上报；
// 「测试连接」传 stream:false 保持非流式（探针要的是最小真实请求，不需要进度）
export async function generateDigest({ config, instruction, content, pdf = null, fetchImpl = fetch, maxOutputTokens, timeoutMs, stream = true, onProgress = null }) {
  if (!config || !AI_API_TYPES.includes(config.apiType) || !config.model || !config.apiKey) {
    throw aiError('AI_NOT_CONFIGURED', '未配置 AI API');
  }
  const merged = { ...config, baseUrl: config.baseUrl || AI_DEFAULT_BASE_URL[config.apiType] };
  const outputTokens = maxOutputTokens ?? merged.maxOutputTokens ?? AI_MAX_OUTPUT_TOKENS;
  const requestTimeoutMs = timeoutMs ?? merged.timeoutMs ?? AI_TIMEOUT_MS;
  const request = REQUEST_BUILDERS[merged.apiType](merged, stripFilePlaceholder(instruction), truncateInput(content), outputTokens, pdf, stream);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response;
  try {
    // redirect:'error'：AI 端点不该跳转，跳转了多半是配置错的网关/代理，直接失败
    response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
      redirect: 'error',
    });
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw aiError('AI_TIMEOUT', 'AI 请求超时');
    }
    throw aiError('AI_REQUEST_FAILED', error?.message);
  } finally {
    // 非流式沿用旧口径（计时只覆盖响应头到达）；流式计时覆盖整个事件流消费，
    // 在下方消费完成后才停表——慢流（reasoning 模型长思考）也受同一 timeoutMs 约束
    if (!stream) clearTimeout(timer);
  }
  if (!response.ok) {
    clearTimeout(timer);
    let detail = '';
    try { detail = extractErrorDetail(await readBodyText(response)); } catch { /* 错误体读不出就用状态码 */ }
    throw aiError(httpErrorCode(response.status), detail || `AI_HTTP_${response.status}`);
  }
  if (stream) {
    try {
      return (await consumeStream(response, merged.apiType, onProgress, controller.signal)).trim();
    } finally {
      clearTimeout(timer);
    }
  }
  let payload;
  try {
    payload = JSON.parse(await readBodyText(response));
  } catch (error) {
    if (error?.code === 'AI_REQUEST_FAILED') throw error;
    throw aiError('AI_REQUEST_FAILED', 'AI 响应不是合法 JSON');
  }
  return EXTRACTORS[merged.apiType](payload).trim();
}

// `{{digest}}` 的最终替换发生在 bridge 侧（扩展渲染时 AI 还没被调用，只保留字面占位符）。
// 契约：占位符替换永远不含默认标题——标题只由默认布局分支添加
export function applyDigest(markdown, digestText) {
  const body = String(markdown ?? '');
  if (/\{\{\s*digest\s*\}\}/.test(body)) {
    return body.replace(/\{\{\s*digest\s*\}\}/g, digestText ?? '');
  }
  if (digestText) return `# Digest\n\n${digestText}\n\n# RAW content\n\n${body}`;
  return body;
}

// applyDigestLink（#98）：subdoc 模式下 {{digest}} 原位渲染为子文档 markdown 链接；
// 无占位符原样返回——默认布局不再注入 # Digest / # RAW content 两节，导航靠父文档顶部子页面列表块。
// link 为 null（子文档不可用）时占位符置空
export function applyDigestLink(markdown, link) {
  const body = String(markdown ?? '');
  if (!/\{\{\s*digest\s*\}\}/.test(body)) return body;
  let text = '';
  if (link && link.url) {
    const title = String(link.title ?? 'Digest').replace(/[[\]]/g, '\\$&').replace(/\s*\n\s*/g, ' ');
    text = `[${title}](${link.url})`;
  }
  return body.replace(/\{\{\s*digest\s*\}\}/g, text);
}

// ——— 配置校验（server 把 TypeError 按 code 翻译成 400，与 normalizePdfSource 同一约定） ———

const bad = (code, message) => Object.assign(new TypeError(message), { code });

function normalizeBaseUrl(value, apiType) {
  if (value === undefined || value === null || value === '') return AI_DEFAULT_BASE_URL[apiType];
  if (typeof value !== 'string' || value.length > AI_LIMITS.baseUrlChars) {
    throw bad('AI_BASE_URL_INVALID', 'baseUrl 必须是 ≤300 字符的 http(s) URL');
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw bad('AI_BASE_URL_INVALID', 'baseUrl 必须是 ≤300 字符的 http(s) URL'); }
  // 允许私有/回环地址（用户显式配置，Ollama 场景）——这是 image-policy 公网-only 策略的显式例外
  if (!['http:', 'https:'].includes(parsed.protocol)) throw bad('AI_BASE_URL_INVALID', 'baseUrl 必须是 ≤300 字符的 http(s) URL');
  return trimTrailingSlash(value);
}

function normalizeModel(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > AI_LIMITS.modelChars) {
    throw bad('AI_MODEL_INVALID', 'model 必须是非空字符串（≤128 字符）');
  }
  return value.trim();
}

function normalizeApiKey(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > AI_LIMITS.apiKeyChars) {
    throw bad('AI_KEY_INVALID', 'apiKey 必须是 ≤512 字符的字符串');
  }
  return value;
}

// 自定义请求头（高级设置）：对象 ≤20 项；名须为 HTTP token（RFC 9110），值 ≤1024 字符。
// undefined/null/'' 与空对象都按「未配置」归一为 undefined
function normalizeHeaders(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw bad('AI_HEADERS_INVALID', 'headers 必须是「头名: 值」的对象（≤20 项）');
  }
  const entries = Object.entries(value);
  if (!entries.length) return undefined;
  if (entries.length > AI_LIMITS.headerCount) {
    throw bad('AI_HEADERS_INVALID', 'headers 必须是「头名: 值」的对象（≤20 项）');
  }
  const headers = {};
  for (const [name, headerValue] of entries) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/.test(name) || typeof headerValue !== 'string' || headerValue.length > AI_LIMITS.headerValueChars) {
      throw bad('AI_HEADERS_INVALID', `请求头 ${name.slice(0, AI_LIMITS.headerNameChars)} 非法：头名须为 HTTP token，值须为 ≤1024 字符的字符串`);
    }
    headers[name] = headerValue;
  }
  return headers;
}

// 最大输出 tokens（高级设置）：选填整数 [16, 128_000]；留空按「未配置」归一为 undefined
function normalizeMaxOutputTokens(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 16 || value > AI_MAX_OUTPUT_TOKENS_LIMIT) {
    throw bad('AI_MAX_OUTPUT_TOKENS_INVALID', 'maxOutputTokens 必须是 16–128000 的整数');
  }
  return value;
}

// 请求超时（高级设置）：选填整数毫秒 [5_000, 1_800_000]（5–1800 秒）；留空按「未配置」归一为 undefined
function normalizeTimeoutMs(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < AI_TIMEOUT_MS_MIN || value > AI_TIMEOUT_MS_LIMIT) {
    throw bad('AI_TIMEOUT_MS_INVALID', 'timeoutMs 必须是 5000–1800000 的整数（5–1800 秒）');
  }
  return value;
}

// reasoning 三态（#96）：'on' / 'off'，省略/null/空串 = 默认（不发参数，跟随服务端默认）。
// 非法值报错不静默丢弃（与 headers 等高级项同一约定）
function normalizeReasoning(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value !== 'on' && value !== 'off') {
    throw bad('AI_REASONING_INVALID', 'reasoning 必须是 on / off（留空 = 跟随服务端默认）');
  }
  return value;
}

export function normalizeAiConfigInput(body, { requireKey = false } = {}) {
  if (!body || typeof body !== 'object') throw bad('AI_CONFIG_INVALID', 'AI 配置必须是对象');
  if (!AI_API_TYPES.includes(body.apiType)) throw bad('AI_TYPE_INVALID', 'apiType 必须是 responses / chat-completions / messages');
  const apiKey = normalizeApiKey(body.apiKey);
  // 首次保存 apiKey 必填；后续保存省略/空串 = 保留已存 key（由 store.save 落库时合并）
  if (requireKey && !apiKey) throw bad('AI_KEY_REQUIRED', '首次保存必须提供 apiKey');
  const config = {
    apiType: body.apiType,
    baseUrl: normalizeBaseUrl(body.baseUrl, body.apiType),
    model: normalizeModel(body.model),
    apiKey,
  };
  // 高级设置（选填）：保存语义与 baseUrl/model 相同——表单是事实源，清空即移除
  const headers = normalizeHeaders(body.headers);
  const maxOutputTokens = normalizeMaxOutputTokens(body.maxOutputTokens);
  const timeoutMs = normalizeTimeoutMs(body.timeoutMs);
  const reasoning = normalizeReasoning(body.reasoning);
  if (headers) config.headers = headers;
  if (maxOutputTokens) config.maxOutputTokens = maxOutputTokens;
  if (timeoutMs) config.timeoutMs = timeoutMs;
  if (reasoning) config.reasoning = reasoning;
  return config;
}

// 测试连接的逐项覆盖合并：省略或空串的字段回落到已存配置（与 apiKey 同一语义，
// 设置页清空某框点「测试连接」应探测已存配置而非类型默认值）；无已存配置且未给全 → AI_NOT_CONFIGURED
export function mergeAiTestConfig(overrides = {}, saved = null) {
  const present = (value) => (typeof value === 'string' && value.trim() ? value : undefined);
  const apiType = overrides.apiType ?? saved?.apiType;
  const apiKey = present(overrides.apiKey) ?? saved?.apiKey;
  if (!AI_API_TYPES.includes(apiType) || !apiKey) throw bad('AI_NOT_CONFIGURED', '未配置 AI API');
  let model;
  try {
    model = normalizeModel(present(overrides.model) ?? saved?.model);
  } catch {
    throw bad('AI_NOT_CONFIGURED', '未配置 AI API');
  }
  const merged = { apiType, baseUrl: normalizeBaseUrl(present(overrides.baseUrl) ?? saved?.baseUrl, apiType), model, apiKey };
  // 高级项同 apiKey 语义：省略/空回落已存；覆盖值本身非法则报错（不静默回落）
  const headers = normalizeHeaders(overrides.headers) ?? saved?.headers;
  const maxOutputTokens = normalizeMaxOutputTokens(overrides.maxOutputTokens) ?? saved?.maxOutputTokens;
  const timeoutMs = normalizeTimeoutMs(overrides.timeoutMs) ?? saved?.timeoutMs;
  const reasoning = normalizeReasoning(overrides.reasoning) ?? saved?.reasoning;
  if (headers) merged.headers = headers;
  if (maxOutputTokens) merged.maxOutputTokens = maxOutputTokens;
  if (timeoutMs) merged.timeoutMs = timeoutMs;
  if (reasoning) merged.reasoning = reasoning;
  return merged;
}

// 端点出参脱敏：绝不回显 key，只回 hasKey（按实存 key 推导，不写死）；
// headers/maxOutputTokens/timeoutMs/reasoning 非机密，随配置回显供设置页回填
export function sanitizeAiConfig(config) {
  const safe = { apiType: config.apiType, baseUrl: config.baseUrl, model: config.model, hasKey: Boolean(config.apiKey) };
  if (config.headers) safe.headers = config.headers;
  if (config.maxOutputTokens) safe.maxOutputTokens = config.maxOutputTokens;
  if (config.timeoutMs) safe.timeoutMs = config.timeoutMs;
  if (config.reasoning) safe.reasoning = config.reasoning;
  return safe;
}

// ——— 多 provider（#77）：ai.json 形态 { providers: { 名字: 单套配置 } } ———

// 保留名：旧版单配置（#75）迁移而来，端点层强制其可编辑但不可删除/改名
export const DEFAULT_PROVIDER_NAME = '默认';

export function normalizeProviderName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 64) {
    throw bad('AI_PROVIDER_NAME_INVALID', 'provider 名称必须是非空字符串（≤64 字符）');
  }
  return value.trim();
}

// 随名脱敏：在 sanitizeAiConfig 之上带名字（列表端点与设置页回填用）
export function sanitizeProvider(name, config) {
  return { name, ...sanitizeAiConfig(config) };
}

// 仿 PairingStore（src/bridge/pairing.mjs）：原子写 + 0600；文件不存在按「未配置」读（null）。
// 旧版单配置形态（顶层带 apiType）首次读取时自动包成「默认」provider 并立即落盘
export class AiConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async writeAll(data) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.new`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  async read() {
    let raw;
    try {
      raw = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (raw?.providers && typeof raw.providers === 'object') return { providers: raw.providers };
    // 旧版单配置 → 迁移为「默认」provider（原 key/高级设置原样保留）并落盘
    const migrated = { providers: { [DEFAULT_PROVIDER_NAME]: raw } };
    await this.writeAll(migrated);
    return migrated;
  }

  // 列表：「默认」恒在最前，其余按插入序
  async list() {
    const providers = (await this.read())?.providers ?? {};
    return [DEFAULT_PROVIDER_NAME, ...Object.keys(providers).filter((name) => name !== DEFAULT_PROVIDER_NAME)]
      .filter((name) => providers[name])
      .map((name) => ({ name, ...providers[name] }));
  }

  async readProvider(name) {
    return (await this.read())?.providers?.[name] ?? null;
  }

  // 默认 provider 语义：有「默认」用它；没有（全新安装直接建了别的名字）回落第一套
  async readDefault() {
    const providers = (await this.read())?.providers ?? {};
    return providers[DEFAULT_PROVIDER_NAME] ?? Object.values(providers)[0] ?? null;
  }

  // upsert：留空/省略 apiKey = 保留该 provider 已存 key（首次保存的必填校验在 server 层）；
  // renameFrom 把旧名的已存 key 一并搬过来并删除旧名（改名不丢 key）
  async saveProvider(name, config, { renameFrom } = {}) {
    const providers = { ...((await this.read())?.providers ?? {}) };
    const existing = providers[name] ?? (renameFrom ? providers[renameFrom] : null);
    providers[name] = { ...config, apiKey: config.apiKey || existing?.apiKey || '' };
    if (renameFrom && renameFrom !== name) delete providers[renameFrom];
    await this.writeAll({ providers });
    return providers[name];
  }

  async deleteProvider(name) {
    const providers = (await this.read())?.providers ?? {};
    if (!providers[name]) return false;
    const next = { ...providers };
    delete next[name];
    await this.writeAll({ providers: next });
    return true;
  }
}
