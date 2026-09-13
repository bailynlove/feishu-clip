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

export const AI_TIMEOUT_MS = 60_000;
export const AI_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const AI_MAX_INPUT_CHARS = 100_000;
export const AI_MAX_OUTPUT_TOKENS = 2048;
// maxOutputTokens 选填上限：reasoning 模型（gpt-5 系/o 系）reasoning 也烧 output tokens，
// 默认 2048 可能不够，用户可在「高级设置」调高；上限防手滑
export const AI_MAX_OUTPUT_TOKENS_LIMIT = 128_000;

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

// ——— 请求构造器（每型 ~20 行，非流式）：认证方式与请求体形状按类型各自的契约 ———

const REQUEST_BUILDERS = {
  // OpenAI Responses：instructions 是顶层系统指令字段，input 可以是纯字符串；
  // store:false 关闭服务端留存；max_output_tokens 是这型的上限字段。
  // config.headers（高级设置的自定义请求头）最后展开：可追加路由头（如 opencode-go 的
  // x-opencode-session），也可覆盖默认头（特殊网关改认证方案场景）——三型同一约定
  responses(config, instruction, content, maxOutputTokens) {
    return {
      url: `${trimTrailingSlash(config.baseUrl)}/responses`,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', ...config.headers },
      body: { model: config.model, instructions: instruction, input: content, store: false, max_output_tokens: maxOutputTokens },
    };
  },
  // OpenAI Chat Completions：max_tokens 已废弃，必须用 max_completion_tokens
  'chat-completions': (config, instruction, content, maxOutputTokens) => ({
    url: `${trimTrailingSlash(config.baseUrl)}/chat/completions`,
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', ...config.headers },
    body: {
      model: config.model,
      messages: [{ role: 'system', content: instruction }, { role: 'user', content }],
      max_completion_tokens: maxOutputTokens,
    },
  }),
  // Anthropic Messages：max_tokens 必填；system 是顶层字段不在 messages 里；
  // anthropic-version 为必传头，硬编码当前文档示例值
  messages(config, instruction, content, maxOutputTokens) {
    return {
      url: `${trimTrailingSlash(config.baseUrl)}/v1/messages`,
      headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', ...config.headers },
      body: { model: config.model, max_tokens: maxOutputTokens, system: instruction, messages: [{ role: 'user', content }] },
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

// fetchImpl 可注入（测试不走网络）；maxOutputTokens 显式参数（测试连通性探针与超时测试）
// 优先，其次 config.maxOutputTokens（高级设置），最后内置默认 2048
export async function generateDigest({ config, instruction, content, fetchImpl = fetch, maxOutputTokens, timeoutMs = AI_TIMEOUT_MS }) {
  if (!config || !AI_API_TYPES.includes(config.apiType) || !config.model || !config.apiKey) {
    throw aiError('AI_NOT_CONFIGURED', '未配置 AI API');
  }
  const merged = { ...config, baseUrl: config.baseUrl || AI_DEFAULT_BASE_URL[config.apiType] };
  const outputTokens = maxOutputTokens ?? merged.maxOutputTokens ?? AI_MAX_OUTPUT_TOKENS;
  const request = REQUEST_BUILDERS[merged.apiType](merged, instruction, truncateInput(content), outputTokens);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw aiError('AI_TIMEOUT', 'AI 请求超时');
    }
    throw aiError('AI_REQUEST_FAILED', error?.message);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    let detail = '';
    try { detail = extractErrorDetail(await readBodyText(response)); } catch { /* 错误体读不出就用状态码 */ }
    throw aiError(httpErrorCode(response.status), detail || `AI_HTTP_${response.status}`);
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
  if (headers) config.headers = headers;
  if (maxOutputTokens) config.maxOutputTokens = maxOutputTokens;
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
  if (headers) merged.headers = headers;
  if (maxOutputTokens) merged.maxOutputTokens = maxOutputTokens;
  return merged;
}

// 端点出参脱敏：绝不回显 key，只回 hasKey（按实存 key 推导，不写死）；
// headers/maxOutputTokens 非机密，随配置回显供设置页回填
export function sanitizeAiConfig(config) {
  const safe = { apiType: config.apiType, baseUrl: config.baseUrl, model: config.model, hasKey: Boolean(config.apiKey) };
  if (config.headers) safe.headers = config.headers;
  if (config.maxOutputTokens) safe.maxOutputTokens = config.maxOutputTokens;
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
