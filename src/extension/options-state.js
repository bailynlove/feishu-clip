// 设置页预设管理的纯归约逻辑（#35）：不依赖 DOM 或 chrome API，node:test 直接测。
// state 形状：{ presets: [...], defaultPresetId }，与 chrome.storage 里的形状一致。
// 所有操作返回新 state；删除到最后一套等非法操作返回 null 表示拒绝。

import { createDefaultPreset } from './presets.js';

// 模板变量快捷插入（决议 #30 的 v1 变量集；#75 增加 digest——仅预设开了 AI 摘要开关时
// 占位符才会被替换，否则按未知变量置空，插入按钮不做开关感知）
export const TEMPLATE_VARIABLES = ['title', 'url', 'host', 'date', 'time', 'datetime', 'content', 'digest'];

// {{@file}} 附件占位符（#81）：摘要指令专属——bridge 检出该占位符时把本次剪藏 PDF 以 base64
// 附件随摘要请求发给 AI；无 PDF 时降级为纯文本摘要。不进 TEMPLATE_VARIABLES：
// 标题/正文模板变量在摘要指令里不会被替换，指令框的变量行只列 @file
export const FILE_ATTACHMENT_VARIABLE = '@file';

// .ps-vars 变量行的按钮名单：data-vars 显式指定（逗号/空格分隔）时优先，否则用默认模板变量集
export function variableRowNames(dataVars) {
  const explicit = String(dataVars ?? '').split(/[,\s]+/).filter(Boolean);
  return explicit.length > 0 ? explicit : TEMPLATE_VARIABLES;
}

// 图片写入模式三态（#53）：选项顺序即设置页分段控件顺序；说明文案体现三者的取舍
export const IMAGE_MODE_OPTIONS = [
  { value: 'preview', label: '预览优先', hint: '公开图片直接嵌入预览块，最快；依赖原站可持续访问' },
  { value: 'download', label: '下载优先', hint: '公开图片也下载上传为真实图片，较慢但更持久' },
  { value: 'off', label: '不保存', hint: '不保存图片，原位保留可读文本与原图链接' },
];

export function imageModeHint(mode) {
  return (IMAGE_MODE_OPTIONS.find((option) => option.value === mode) ?? IMAGE_MODE_OPTIONS[0]).hint;
}

// ——— 分区折叠（#76）：第 2 区「AI 摘要」/ 第 3 区「预设管理」可折叠，状态存
// chrome.storage.local 单键 optionsUiCollapsed（{ aiDigest, presets }，true = 收起）。
// 默认展开：缺键/非法值一律归一为 false（展开）——配对区与开发者模式区不参与折叠 ———
export const OPTIONS_COLLAPSE_KEY = 'optionsUiCollapsed';

// details 元素 id → 存储字段；options.js 按此表接线 init 回填与 toggle 事件
export const COLLAPSIBLE_SECTIONS = Object.freeze([
  { id: 'ai-section-collapse', key: 'aiDigest' },
  { id: 'presets-section-collapse', key: 'presets' },
]);

export function normalizeCollapsedSections(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return Object.fromEntries(COLLAPSIBLE_SECTIONS.map(({ key }) => [key, source[key] === true]));
}

export function setSectionCollapsed(state, key, collapsed) {
  return { ...normalizeCollapsedSections(state), [key]: Boolean(collapsed) };
}

function findIndex(state, id) {
  return state.presets.findIndex((preset) => preset.id === id);
}

export function updatePreset(state, id, patch) {
  const index = findIndex(state, id);
  if (index < 0) return state;
  const presets = state.presets.slice();
  presets[index] = { ...presets[index], ...patch };
  return { ...state, presets };
}

export function renamePreset(state, id, name) {
  return updatePreset(state, id, { name: String(name ?? '') });
}

export function addPreset(state) {
  const preset = createDefaultPreset({ name: `预设 ${state.presets.length + 1}` });
  return { ...state, presets: [...state.presets, preset] };
}

// 复制：新 id、名称加「副本」，插在原预设之后
export function duplicatePreset(state, id) {
  const index = findIndex(state, id);
  if (index < 0) return state;
  const source = state.presets[index];
  const copy = { ...source, id: crypto.randomUUID(), name: `${source.name} 副本`, triggers: [...source.triggers] };
  const presets = state.presets.slice();
  presets.splice(index + 1, 0, copy);
  return { ...state, presets };
}

// 至少保留一套：只剩一套时拒绝删除（返回 null）。
// 删除默认预设时默认顺延列表第一套（决议 #29）。
export function removePreset(state, id) {
  if (state.presets.length <= 1) return null;
  const index = findIndex(state, id);
  if (index < 0) return state;
  const presets = state.presets.filter((preset) => preset.id !== id);
  const defaultPresetId = state.defaultPresetId === id ? presets[0].id : state.defaultPresetId;
  return { ...state, presets, defaultPresetId };
}

// delta -1 上移 / +1 下移；越界时原地不动
export function movePreset(state, id, delta) {
  const index = findIndex(state, id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= state.presets.length) return state;
  const presets = state.presets.slice();
  [presets[index], presets[target]] = [presets[target], presets[index]];
  return { ...state, presets };
}

export function setDefaultPreset(state, id) {
  if (findIndex(state, id) < 0) return state;
  return { ...state, defaultPresetId: id };
}

// ——— triggers 规则校验（决议 #32）：一行一条 ———
// 合法：前缀以 http(s):// 开头；或 /pattern/（可带 i 标志）且 new RegExp 不抛错。
// 返回 { line, text, reason } 列表，line 为 1 起始行号；空行跳过。

const REGEX_RULE = /^\/(.+)\/([a-z]*)$/;

function validateRule(text) {
  const regex = REGEX_RULE.exec(text);
  if (regex) {
    const [, pattern, flags] = regex;
    if (!/^[i]*$/.test(flags)) return '正则只支持 i 标志';
    try {
      new RegExp(pattern, flags);
    } catch {
      return '正则表达式非法';
    }
    return null;
  }
  if (text.startsWith('/')) return '正则须写成 /pattern/ 形式';
  if (!/^https?:\/\//.test(text)) return '前缀须以 http(s):// 开头';
  return null;
}

export function validateTriggers(text) {
  const errors = [];
  String(text ?? '')
    .split('\n')
    .forEach((raw, index) => {
      const line = raw.trim();
      if (line === '') return;
      const reason = validateRule(line);
      if (reason) errors.push({ line: index + 1, text: line, reason });
    });
  return errors;
}

// 解析为规则数组：去空行、去首尾空白。调用前应先过 validateTriggers。
export function parseTriggers(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

// 变量快捷插入：在 cursor 处插入 {{name}}，返回新文本与新光标位置（插入内容之后）
export function insertVariable(text, cursor, name) {
  const value = String(text ?? '');
  const at = Math.max(0, Math.min(Number(cursor) || 0, value.length));
  const snippet = `{{${name}}}`;
  return { text: value.slice(0, at) + snippet + value.slice(at), cursor: at + snippet.length };
}

// ——— 开发者模式：任务耗时日志的纯展示逻辑 ———
// 输入为 bridge GET /v1/jobs 返回的 job 对象；输出全部是给 DOM 渲染用的字符串/结构化行，
// 不碰 DOM 与 chrome API，node:test 直测。

// 状态归类：决定任务行状态点的颜色（成功绿/警告黄/失败红/进行中蓝）。
// cancelled* 是用户主动行为不算失败，归警告；needs_attention/expired 需要用户介入，归失败。
export function jobStatusTone(status) {
  switch (status) {
    case 'succeeded': return 'success';
    case 'succeeded_with_warnings':
    case 'cancelled':
    case 'cancelled_with_document': return 'warning';
    case 'queued':
    case 'running': return 'running';
    default: return 'error';
  }
}

// 状态中文标签，跟状态点并排展示
export function jobStatusLabel(status) {
  switch (status) {
    case 'succeeded': return '成功';
    case 'succeeded_with_warnings': return '有警告';
    case 'failed': return '失败';
    case 'needs_attention': return '需处理';
    case 'expired': return '已过期';
    case 'cancelled': return '已取消';
    case 'cancelled_with_document': return '已取消（文档已建）';
    case 'queued': return '排队中';
    case 'running': return '进行中';
    default: return String(status ?? '未知');
  }
}

// 耗时格式化：<1s 显示毫秒（页面提取常在此区间），否则保留一位小数的秒
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// 任务行总耗时列：进行中（未终态）显示「进行中」，终态无 totalMs（老数据）显示「—」
export function jobTotalLabel(job) {
  if (jobStatusTone(job?.status) === 'running') return '进行中';
  return formatDuration(job?.totalMs);
}

// 开始时间 HH:MM:SS（本地时区）；缺 createdAt 时兜底
export function formatClock(epochMs) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '—';
  const date = new Date(epochMs);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// 任务行标题：bridge 记录的剪藏标题优先；无标题回退来源 host，再退完整 URL
export function jobDisplayTitle(job) {
  const title = String(job?.title ?? '').trim();
  if (title) return title;
  try {
    return new URL(job?.sourceUrl).host;
  } catch {
    return String(job?.sourceUrl ?? '') || '未知任务';
  }
}

// stage 的 name 是机器标识，展示用中文名（digest 阶段见 #75；digest_doc 子文档阶段见 #98）
const STAGE_LABELS = { create_document: '创建文档', images: '图片处理', pdf_download: '下载 PDF', digest: 'AI 摘要', digest_doc: '摘要子文档' };

// 展开明细行：页面提取（扩展侧 clientTiming）+ bridge timeline 按原顺序平铺。
// 每行 { label, value, indent, failed }；indent 用于缩进层级（stage 0 / image 1 / cli 2）。
export function jobDetailRows(job) {
  const rows = [];
  const extractMs = job?.clientTiming?.extractMs;
  if (typeof extractMs === 'number') {
    rows.push({ label: '页面提取', value: formatDuration(extractMs), indent: 0, failed: false });
  }
  for (const entry of job?.timeline ?? []) {
    if (entry?.kind === 'stage') {
      rows.push({ label: STAGE_LABELS[entry.name] ?? String(entry.name ?? ''), value: formatDuration(entry.ms), indent: 0, failed: false });
    } else if (entry?.kind === 'image') {
      // name 形如 image-<n>；失败时 detail 为原因
      const label = String(entry.name ?? '').replace(/^image-/, '图片 ');
      if (entry.detail) rows.push({ label, value: `失败：${entry.detail}`, indent: 1, failed: true });
      else rows.push({ label, value: formatDuration(entry.ms), indent: 1, failed: false });
    } else if (entry?.kind === 'cli') {
      rows.push({ label: String(entry.name ?? ''), value: formatDuration(entry.ms), indent: 2, failed: false });
    }
  }
  return rows;
}

// ——— AI 摘要（#75）：设置页 AI API 配置的纯展示/归约逻辑 ———
// API key 只存 bridge 的 ai.json，扩展侧不落地；这里只有表单草稿 → 请求体的归约与结果展示

// {{@file}} 行内提示（#81）：预设级指令含 {{@file}} 但该预设未开「PDF 存云盘」（pdfDrive）时提示——
// 只提示不阻止保存：指令分全局/预设两层，全局指令场景无法静态判定有没有 PDF 可附。
// 检出口径与 bridge 端 hasFilePlaceholder（src/bridge/ai-digest.mjs）同一正则（容忍 {{ @file }} 空格
// 写法）——两运行时无法共享模块，修改须两边同步
const FILE_PLACEHOLDER = /\{\{\s*@file\s*\}\}/;

export function digestFileHintNeeded(instruction, pdfDriveEnabled) {
  return FILE_PLACEHOLDER.test(String(instruction ?? '')) && pdfDriveEnabled !== true;
}

// API 类型下拉选项（value = bridge 契约的 apiType，label 为设置页展示名）
export const AI_API_TYPE_OPTIONS = [
  { value: 'responses', label: 'OpenAI Responses' },
  { value: 'chat-completions', label: 'OpenAI Chat Completions' },
  { value: 'messages', label: 'Anthropic Messages' },
];

// 各类型的默认 Base URL（与 bridge 契约一致）：messages 的 base 不带 /v1
export const AI_DEFAULT_BASE_URLS = {
  responses: 'https://api.openai.com/v1',
  'chat-completions': 'https://api.openai.com/v1',
  messages: 'https://api.anthropic.com',
};

export function aiDefaultBaseUrl(apiType) {
  return AI_DEFAULT_BASE_URLS[apiType] ?? AI_DEFAULT_BASE_URLS.responses;
}

// 「高级设置」textarea 逐行解析：每行 `Name: value`，空行跳过；缺冒号/空头名即报错
// （设置页 catch 后行内展示），不静默丢弃用户输入
export function aiHeadersFromText(text) {
  const headers = {};
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) throw new Error(`请求头格式错误：「${trimmed}」应为 Name: value`);
    const name = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw new Error(`请求头名「${name}」非法`);
    headers[name] = value;
  }
  return headers;
}

// 已存 headers 对象 → textarea 回填文本（与 aiHeadersFromText 互逆）
export function aiHeadersToText(headers) {
  return Object.entries(headers ?? {}).map(([name, value]) => `${name}: ${value}`).join('\n');
}

// 最大输出 tokens 输入框：留空 = 未设置；否则须为正整数（范围由 bridge 校验）
export function aiMaxOutputTokensFromText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) throw new Error('最大输出 tokens 必须是正整数');
  return Number.parseInt(trimmed, 10);
}

// 超时输入框（秒）：留空 = 未设置；否则须为正整数，换算成毫秒进 body（范围由 bridge 校验）
export function aiTimeoutMsFromText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) throw new Error('超时秒数必须是正整数');
  return Number.parseInt(trimmed, 10) * 1000;
}

// 表单草稿 → 保存/测试请求体：baseUrl 留空用类型默认值；apiKey 留空不放进 body
// （bridge 语义：省略/空串 = 保留已存 key）；apiType 非法值归一为 responses。
// 高级设置三项留空同样不进 body（bridge 回落已存/内置默认）；格式非法抛错由调用方展示。
// reasoning（#96 三态）：下拉 value 即 'on'/'off'/''，只有开/关进 body，'' = 默认（不发参数）。
// name/renameFrom（#77 多 provider）：name 为保存目标名；改名时 renameFrom 带原名
export function aiConfigPayload({ apiType, baseUrl, model, apiKey, headersText, maxOutputTokensText, timeoutText, reasoning, name, renameFrom } = {}) {
  const type = AI_DEFAULT_BASE_URLS[apiType] ? apiType : 'responses';
  const payload = {
    apiType: type,
    baseUrl: String(baseUrl ?? '').trim() || aiDefaultBaseUrl(type),
    model: String(model ?? '').trim(),
  };
  const key = String(apiKey ?? '').trim();
  if (key) payload.apiKey = key;
  const headers = aiHeadersFromText(headersText);
  if (Object.keys(headers).length) payload.headers = headers;
  const maxOutputTokens = aiMaxOutputTokensFromText(maxOutputTokensText);
  if (maxOutputTokens !== undefined) payload.maxOutputTokens = maxOutputTokens;
  const timeoutMs = aiTimeoutMsFromText(timeoutText);
  if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs;
  if (reasoning === 'on' || reasoning === 'off') payload.reasoning = reasoning;
  const providerName = String(name ?? '').trim();
  if (providerName) payload.name = providerName;
  if (renameFrom) payload.renameFrom = String(renameFrom).trim();
  return payload;
}

// ——— provider 列表（#77）：bridge GET /v1/ai/providers 的 sanitized 数组（无 key 本身） ———

// 默认 provider 名（与 bridge DEFAULT_PROVIDER_NAME 契约一致；两个运行时无法共享模块，各自定义）
export const DEFAULT_AI_PROVIDER_NAME = '默认';

export function aiProviderByName(providers, name) {
  return (providers ?? []).find((provider) => provider.name === name) ?? null;
}

// 选中名解析：当前选中有效原样保留；失效（被删/首载）回落「默认」，再回落第一个；
// 空列表 → null（设置页据此进入新建草稿态）
export function resolveAiProviderSelection(providers, selected) {
  if (aiProviderByName(providers, selected)) return selected;
  return aiProviderByName(providers, DEFAULT_AI_PROVIDER_NAME)?.name ?? providers?.[0]?.name ?? null;
}

// 预设表单的 provider 下拉选项（#78）：首项固定「默认」（value '' = 跟随默认 provider）；
// 名为「默认」的 provider 已含于首项语义，不重复列；bridge 列表拿不到时仅首项（降级）
export function aiDigestProviderOptions(providers) {
  const named = (providers ?? []).filter((provider) => provider.name !== DEFAULT_AI_PROVIDER_NAME)
    .map((provider) => ({ value: provider.name, label: provider.name }));
  return [{ value: '', label: DEFAULT_AI_PROVIDER_NAME }, ...named];
}

// 测试连接失败的中文文案：已知机器码用固定文案，未知错误透传 bridge 返回的 message
const AI_ERROR_LABELS = {
  AI_NOT_CONFIGURED: '尚未配置 AI API，请先保存配置',
  AI_AUTH_FAILED: 'API key 无效或权限不足',
  AI_RATE_LIMITED: '请求被限流，请稍后重试',
  AI_TIMEOUT: '请求超时',
};

// 测试连接的行内结果：成功显示延迟与回复摘录；失败显示中文错误
// 入参为 bridge POST /v1/ai/test 的响应体（{ ok:true, latencyMs, reply } | { ok:false, code, message }）
export function aiTestResultView(result) {
  if (result?.ok === true) {
    const reply = String(result.reply ?? '').trim();
    return { tone: 'success', text: `连接成功 ✓ 延迟 ${formatDuration(result.latencyMs)}${reply ? `，回复摘录：${reply}` : ''}` };
  }
  return { tone: 'error', text: `连接失败：${AI_ERROR_LABELS[result?.code] ?? String(result?.message ?? '未知错误')}` };
}

// ——— 触发规则预设气泡（#101）：全局键 triggerPresets 存 [{ id, name, rule }]，不属于任何单套预设；
// 点击气泡把 rule 追加进 triggers 输入框（一行一条）；只支持新增/删除，不做编辑 ———
export const TRIGGER_PRESETS_KEY = 'triggerPresets';

// 读取归一：非数组/缺 name/缺 rule 的条目丢弃；name/rule 去首尾空白；缺 id 补生成
export function normalizeTriggerPresets(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item.name === 'string' && item.name.trim() && typeof item.rule === 'string' && item.rule.trim())
    .map((item) => ({
      id: typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID(),
      name: item.name.trim(),
      rule: item.rule.trim(),
    }));
}

// 新增：名称/规则去空白后都必须非空，重名拒绝；非法返回 null（调用侧提示）
export function addTriggerPreset(list, { name, rule } = {}) {
  const trimmedName = String(name ?? '').trim();
  const trimmedRule = String(rule ?? '').trim();
  if (!trimmedName || !trimmedRule) return null;
  if (list.some((item) => item.name === trimmedName)) return null;
  return [...list, { id: crypto.randomUUID(), name: trimmedName, rule: trimmedRule }];
}

// 内置预设（builtin- 前缀 id）不可删，防御性原样返回
export function removeTriggerPreset(list, id) {
  if (typeof id === 'string' && id.startsWith('builtin-')) return list;
  return list.filter((item) => item.id !== id);
}

// 追加规则到 triggers 文本：一行一条；文本空白直用规则；文本尾随换行先去掉再补一个，不叠空行
export function appendTriggerRule(text, rule) {
  const trimmedRule = String(rule ?? '').trim();
  const current = String(text ?? '');
  if (!trimmedRule) return current;
  if (!current.trim()) return trimmedRule;
  return `${current.replace(/\s+$/, '')}\n${trimmedRule}`;
}

// ——— 内置规则预设（#95）：paper = 论文站点清单，照 Zotero Connector translator targets 取高频子集；
// 常驻不可删：读取时经 mergeBuiltInTriggerPresets 缺失即补，UI 不给删除入口。
// 规则语法与 triggers 校验一致（一行一条；/pattern/i 正则或 http(s) 前缀）——
// 每行一个站点域名，([a-z0-9-]+\.)* 覆盖任意级子域名 ———
const PAPER_TRIGGER_RULES = `/^https?:\\/\\/([a-z0-9-]+\\.)*arxiv\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*doi\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*semanticscholar\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*dblp\\.org\\//i
/^https?:\\/\\/scholar\\.google\\.[a-z.]{2,}\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*nlm\\.nih\\.gov\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*ieee\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*acm\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*usenix\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*springer\\.com\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*nature\\.com\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*science\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*sciencedirect\\.com\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*wiley\\.com\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*tandfonline\\.com\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*jstor\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*oup\\.com\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*cambridge\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*rsc\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*aps\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*aip\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*iop\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*cell\\.com\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*plos\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*frontiersin\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*mdpi\\.com\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*biorxiv\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*medrxiv\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*openreview\\.net\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*aclanthology\\.org\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*neurips\\.cc\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*mlr\\.press\\//i
/^https?:\\/\\/([a-z0-9-]+\\.)*thecvf\\.com\\//i
/^https?:\\/\\/huggingface\\.co\\/papers\\//i`;

export const BUILT_IN_TRIGGER_PRESETS = Object.freeze([
  { id: 'builtin-paper', name: 'paper', rule: PAPER_TRIGGER_RULES },
]);

// 并入口径：内置预设常驻不可删——无论 storage 键是否存在，缺失即补（按 id 判重），
// 内置在前、用户预设在后；不落库（每次打开重并，内置不进用户数据）
export function mergeBuiltInTriggerPresets(raw) {
  const list = normalizeTriggerPresets(raw);
  const missing = BUILT_IN_TRIGGER_PRESETS.filter((builtin) => !list.some((item) => item.id === builtin.id));
  return [...missing, ...list];
}
