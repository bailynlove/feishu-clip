// 弹窗 job 状态的纯归约逻辑。recovered 表示该 attempt 是打开弹窗时从存储恢复的旧会话：
// 旧会话的终态只作提示，不得把「保存到飞书」主按钮换成「打开文档」——用户可能正准备发起新剪藏。

import { createDefaultPreset, createDriveFolder, DEFAULT_DIGEST_DOC_TITLE, resolveDigest, resolveImageMode, resolvePdfDrive } from './presets.js';
import { buildContext, renderBody, renderTemplate, renderTitle, sanitizeClipTitle, sanitizeFilename } from './templates.js';

export const TERMINAL_STATUSES = new Set(['succeeded', 'succeeded_with_warnings', 'failed', 'needs_attention', 'expired', 'cancelled', 'cancelled_with_document']);

// pdf job 用最小状态集（#60）：无 reconciling/needs_attention
const PDF_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

// job 恢复只属于发起它的页面：跨页面恢复会把旧文档的成功态（含「查看飞书文档」按钮）
// 铺到无关页面上，看起来像"没点保存就存好了"。忽略 hash 差异（同页锚点跳转不算换页）；
// 缺字段或 URL 非法一律按不匹配处理——宁可不恢复，不错恢复。
export function isJobForPage(job, pageUrl) {
  const strip = (value) => {
    try { const url = new URL(value); url.hash = ''; return url.href; } catch { return null; }
  };
  const source = strip(job?.sourceUrl);
  const page = strip(pageUrl);
  return source !== null && page !== null && source === page;
}

// 警告行文本：terminal 有 warnings 时状态条如实呈现内容——取首条，多条追加「等 N 条」
// （状态条单行容量有限）。覆盖图片/iframe 警告与 AI 摘要失败（#75 部分成功降级）同一通道
function warningsText(warnings) {
  const list = Array.isArray(warnings) ? warnings.filter((warning) => typeof warning === 'string' && warning !== '') : [];
  if (list.length === 0) return null;
  return list.length > 1 ? `${list[0]}（等 ${list.length} 条）` : list[0];
}

// AI 摘要阶段进行中（#75 inline / #98 subdoc）：inline 在建档（beginCreate）之前运行——此刻 step 仍是
// create_document 且 createInFlight 未置位、document 未建档、digestText 未落库，
// 与真正的建档阶段用 createInFlight 区分；subdoc 在建档后运行——document 已建档，
// digestProgress 条目存活即摘要进行中（executor 在 digest 阶段开始建 waiting 条目、阶段结束即删）
function clipInDigest(job) {
  if (job?.digest?.enabled !== true || (job.digestText ?? null) !== null) return false;
  if (job.digest.mode !== 'inline') {
    return Boolean(job.document) && job.digestProgress != null;
  }
  return job.step === 'create_document'
    && !job.createInFlight
    && !job.document;
}

// 摘要等待计时（#85）：digest 阶段状态条带「已等待 N 秒」。起算/复位归约——
// popup 侧首次判别进入 digest 阶段记本地时间，离开即复位；仅 popup 开着时有意义，不持久化。
// 输入 GET_JOB 的 jobs 数组；返回新的起算时间（ms），不在 digest 阶段为 null。
export function reduceDigestSince(jobs, digestSince, now) {
  const list = Array.isArray(jobs) ? jobs : [];
  const clip = list.find((job) => (job.kind ?? 'clip') === 'clip') ?? null;
  return clip && clipInDigest(clip) ? (digestSince ?? now) : null;
}

// digest 阶段进度文案：job 视图带 digestProgress（#86 流式）时优先相位/计数——
// thinking（reasoning delta）→「思考中 · 约 N tokens」（#97；计数为 0 = 代理不吐 reasoning
// delta，退回「思考中…」；与等待秒数同时可得时优先计数，单行太挤）；writing →「已生成 N tokens」；
// 字段缺失（旧 bridge）退回 #85 的等待秒数，秒数也没有则维持原样
function digestPhaseText(waitSeconds, digestProgress = null) {
  if (digestProgress?.phase === 'thinking') {
    const tokens = digestProgress.tokens ?? 0;
    return tokens > 0 ? `AI 摘要思考中 · 约 ${tokens} tokens` : 'AI 摘要思考中…';
  }
  if (digestProgress?.phase === 'writing') return `AI 摘要生成中 · 已生成 ${digestProgress.tokens ?? 0} tokens`;
  return waitSeconds == null ? 'AI 摘要生成中…' : `AI 摘要生成中 · 已等待 ${waitSeconds} 秒`;
}

export function describeJobView(job, { recovered = false, digestWaitSeconds = null } = {}) {
  if (job.status === 'succeeded' || job.status === 'succeeded_with_warnings') {
    const warning = warningsText(job.warnings);
    if (warning) {
      return { kind: 'warning', message: `已保存到飞书 · ${warning}`, swapPrimary: !recovered, documentUrl: job.document?.url || null };
    }
    return { kind: 'success', message: '已保存到飞书。', swapPrimary: !recovered, documentUrl: job.document?.url || null };
  }
  if (TERMINAL_STATUSES.has(job.status)) {
    return { kind: 'failure', message: job.error || '剪藏未完成，请修复后重新发起。', swapPrimary: false, documentUrl: null };
  }
  return {
    kind: 'progress',
    message: job.status === 'queued' ? '已提交，等待本地 Bridge 处理…' : clipInDigest(job) ? digestPhaseText(digestWaitSeconds, job.digestProgress) : '正在创建飞书文档并处理图片…',
    swapPrimary: false,
    documentUrl: null,
  };
}

// ——— 双 job 聚合呈现（#60 弹窗协议，#59 变体 A 文案）：输入一次尝试的全部 job，
// 输出单条进度/结论视图；双 job 各自独立成败，UI 上不强调"两个 job"，只呈现结果组合 ———

function clipSucceeded(job) {
  return job.status === 'succeeded' || job.status === 'succeeded_with_warnings';
}

function pdfPhase(pdf) {
  if (!pdf) return null;
  if (pdf.status === 'succeeded') return 'PDF ✓';
  if (PDF_TERMINAL_STATUSES.has(pdf.status)) return 'PDF 上传失败';
  if (pdf.status === 'awaiting_bytes') return 'PDF 凭据回传中…';
  return 'PDF 上传中…';
}

function clipPhase(clip, digestWaitSeconds = null) {
  if (!clip) return null;
  if (clipSucceeded(clip)) return '文档 ✓';
  if (TERMINAL_STATUSES.has(clip.status)) return '文档失败';
  if (clip.status !== 'queued' && clipInDigest(clip)) return digestPhaseText(digestWaitSeconds, clip.digestProgress);
  return '文档保存中…';
}

// 返回 { kind, message, swapPrimary, documentUrl, pdfUrl, pdfRetry, pdfAwaitingBytes }；jobs 为空返回 null。
// pdfAwaitingBytes（#68）：pdf job 在 awaiting_bytes 时为 true，弹窗据此触发凭据回传。
// 单 clip job（未开 PDF 的剪藏）与旧 describeJobView 行为完全一致
export function describeAttemptView(jobs, { recovered = false, digestWaitSeconds = null } = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const clip = list.find((job) => (job.kind ?? 'clip') === 'clip') ?? null;
  const pdfJobs = list.filter((job) => job.kind === 'pdf');
  const pdf = pdfJobs[0] ?? null;
  if (!clip && !pdf) return null;
  const pdfAwaitingBytes = pdfJobs.some((job) => job.status === 'awaiting_bytes');
  if (!pdf) {
    const view = describeJobView(clip, { recovered, digestWaitSeconds });
    return { ...view, pdfUrl: null, pdfRetry: false, pdfAwaitingBytes: false };
  }

  const docOk = clip ? clipSucceeded(clip) : false;
  const clipTerminal = clip ? TERMINAL_STATUSES.has(clip.status) : false;
  const pdfOk = pdfJobs.length > 0 && pdfJobs.every((job) => job.status === 'succeeded');
  const pdfFailed = pdfJobs.some((job) => PDF_TERMINAL_STATUSES.has(job.status) && job.status !== 'succeeded');
  const pdfCount = pdfJobs.length;
  const pdfFailureCount = pdfJobs.filter((job) => PDF_TERMINAL_STATUSES.has(job.status) && job.status !== 'succeeded').length;
  const documentUrl = clip?.document?.url || null;
  const pdfUrl = pdf.document?.url || null;

  // 双产物就位：一行结论 + 两个链接并排（变体 A）；clip 有警告（如 AI 摘要失败）时降级 warning 呈现
  if (docOk && pdfOk) {
    const warning = clip ? warningsText(clip.warnings) : null;
    if (warning) {
      return { kind: 'warning', message: `已保存 ✓ 文档与 PDF 均已入库 · ${warning}`, swapPrimary: !recovered, documentUrl, pdfUrl, pdfRetry: false, pdfAwaitingBytes };
    }
    return { kind: 'success', message: '已保存 ✓ 文档与 PDF 均已入库。', swapPrimary: !recovered, documentUrl, pdfUrl, pdfRetry: false, pdfAwaitingBytes };
  }
  // PDF 失败：文档不受影响，警告横幅 + [打开文档][重试 PDF]
  if (docOk && pdfFailed) {
      return { kind: 'warning', message: `文档已保存 ✓，${pdfCount > 1 ? `${pdfFailureCount}/${pdfCount} 个 PDF 上传失败` : `PDF 上传失败（${pdf.error || '未知错误'}）`}。文档不受影响。`, swapPrimary: false, documentUrl, pdfUrl: null, pdfRetry: true, pdfAwaitingBytes };
  }
  // 文档失败：错误横幅 + [重试文档]（主按钮保持可点），PDF 成功时链接仍可打开
  if (clip && clipTerminal && !docOk) {
    if (pdfFailed) {
      return { kind: 'failure', message: `${clip.error || '剪藏未完成'}；PDF 上传也失败（${pdf.error || '未知错误'}）。`, swapPrimary: false, documentUrl: null, pdfUrl: null, pdfRetry: true, pdfAwaitingBytes };
    }
    if (pdfOk) {
      return { kind: 'failure', message: clip.error || '剪藏未完成，请修复后重新发起。', swapPrimary: false, documentUrl: null, pdfUrl, pdfRetry: false, pdfAwaitingBytes };
    }
  }
  // pdf-only 尝试（PDF 标签页等，本切片不产生但协议允许）：直接呈现 pdf job 状态
  if (!clip) {
    if (pdfOk) return { kind: 'success', message: 'PDF 已存云盘 ✓', swapPrimary: !recovered, documentUrl: null, pdfUrl, pdfRetry: false, pdfAwaitingBytes };
    if (pdfFailed) return { kind: 'failure', message: pdf.error || 'PDF 上传失败。', swapPrimary: false, documentUrl: null, pdfUrl: null, pdfRetry: true, pdfAwaitingBytes };
    if (pdfAwaitingBytes) return { kind: 'progress', message: '需要浏览器凭据回传 PDF，正在传输…', swapPrimary: false, documentUrl: null, pdfUrl: null, pdfRetry: false, pdfAwaitingBytes };
    return { kind: 'progress', message: 'PDF 上传中…', swapPrimary: false, documentUrl: null, pdfUrl: null, pdfRetry: false, pdfAwaitingBytes };
  }
  // 运行中：单条进度 + 阶段文案轮替。文档已成（带警告）但 PDF 仍在途时警告随进度条呈现——
  // 否则「已按纯文本生成摘要」这类降级在 PDF 未完成期间完全不可见（MDPI 事故复盘）
  const runningWarning = docOk && clip ? warningsText(clip.warnings) : null;
  const runningMessage = `${clipPhase(clip, digestWaitSeconds)} · ${pdfCount > 1 ? `PDF ${pdfJobs.filter((job) => job.status === 'succeeded').length}/${pdfCount}` : pdfPhase(pdf)}`;
  return { kind: 'progress', message: runningWarning ? `${runningMessage} · ${runningWarning}` : runningMessage, swapPrimary: false, documentUrl: null, pdfUrl: null, pdfRetry: false, pdfAwaitingBytes };
}

// ——— PDF 存云盘会话开关（#65）：识别结果与会话开关都是仅本次状态，不回写预设 ———

// 识别结果（弹窗打开时 DETECT_PDF 探测）：null 表示本页没有主 PDF
export function setPdfDetected(state, pdf) {
  return { ...state, pdf: pdf ?? null };
}

export function setPdfOn(state, on) {
  return { ...state, pdfOn: Boolean(on) };
}

// 预设默认开关态（读取时迁移：缺字段/非法 pdfDrive 一律视为关）
export function presetPdfEnabled(state) {
  return resolvePdfDrive(currentPreset(state))?.enabled === true;
}

// 预设默认目录（#66）：{ folderToken, folderName } 或 null（未开/根目录之外的语义不变：
// 预设开了但没选目录时 folderToken 为 null = 云盘根目录）
export function presetPdfFolder(state) {
  const resolved = resolvePdfDrive(currentPreset(state));
  return resolved ? createDriveFolder(resolved) : null;
}

function samePdfFolder(a, b) {
  return (a?.folderToken ?? null) === (b?.folderToken ?? null);
}

// 「仅本次」徽标：会话开关或会话目录与预设默认不一致即标注
export function isPdfSessionOnly(state) {
  return state.pdfOn !== presetPdfEnabled(state) || !samePdfFolder(state.pdfFolder, presetPdfFolder(state));
}

// 目录 chip 的「仅本次」徽标：只看目录维度（开关偏离由开关行自己标）
export function isPdfFolderSessionOnly(state) {
  return !samePdfFolder(state.pdfFolder, presetPdfFolder(state));
}

// 目录 chip 的会话选择（#66）：仅本次生效，不回写预设；folder 为 { folderToken, folderName }，
// null/空 token 即云盘根目录
export function setPdfFolder(state, folder) {
  return { ...state, pdfFolder: createDriveFolder({ folderToken: folder?.folderToken, folderName: folder?.folderName }) };
}

// 目录 chip 展示名：根目录 → 固定文案；有 token 无展示名（手贴路径）回退 token 本身
export function pdfFolderLabel(state) {
  const folder = state.pdfFolder;
  if (!folder?.folderToken) return '云盘根目录（我的空间）';
  return folder.folderName ?? folder.folderToken;
}

// 文件大小显示（#65）：拿不到 Content-Length 显示「未知大小」，不阻塞主流程
export function formatPdfSize(sizeBytes) {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) return '未知大小';
  if (sizeBytes < 1024 * 1024) return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

// 文件名显示：识别名缺失时回退 URL 末段，再退通用占位
export function pdfDisplayName(pdf) {
  if (pdf?.name) return pdf.name;
  try {
    const last = new URL(pdf.url).pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch { /* 落到占位 */ }
  return '主 PDF';
}

// ——— PDF 标签页形态（#67）：页面本身是 PDF 时正文区整体换成单面板，不产生剪藏 job ———
// 状态只携带该形态需要的字段：pdf 识别结果 + 会话目录 chip。预设列表不参与展示，
// 仅用于取目录初值（trigger 命中预设 > 默认预设的 pdfDrive 目录；未开/未选 = 云盘根目录），
// 与 #66 网页形态的会话目录口径一致；setPdfFolder/pdfFolderLabel 等会话函数可直接复用
export function initPdfTabState({ presets, defaultPresetId } = {}, pdfTab) {
  const list = Array.isArray(presets) && presets.length > 0 ? presets : [createDefaultPreset()];
  const matchedId = matchTrigger(list, pdfTab?.url);
  const selected = (matchedId ? list.find((preset) => preset.id === matchedId) : null) ?? list.find((preset) => preset.id === defaultPresetId) ?? list[0];
  const pdfDrive = resolvePdfDrive(selected);
  return {
    pageKind: 'pdf-tab',
    presets: list,
    presetId: selected.id,
    pdf: pdfTab ?? null,
    pdfFolder: pdfDrive ? createDriveFolder(pdfDrive) : null,
  };
}

// ——— 临时 AI 摘要（#84，变体 B「开关即折叠」）：会话覆盖态 { on, provider, instruction,
// overridden }。初值由当前预设 digest 配置派生且 overridden=false；用户改任一字段即
// overridden=true；切换预设重置为跟随（applyPresetParams 统一派生）。指令初值恒为空串——
// 留空语义 = 用预设/全局指令，与提交时的回落口径一致 ———

// 预设 digest → 会话初值；provider 空串 = 默认 provider（chips 上显示「默认」）
function sessionDigestFromPreset(preset) {
  const digest = resolveDigest(preset);
  return { on: digest?.enabled === true, provider: digest?.provider ?? '', instruction: '', overridden: false };
}

// pdf-tab 形态（#67）不带 digest 字段，防御性从预设派生
function sessionDigest(state) {
  return state.digest ?? sessionDigestFromPreset(currentPreset(state));
}

export function setDigestOn(state, on) {
  return { ...state, digest: { ...sessionDigest(state), on: Boolean(on), overridden: true } };
}

export function setDigestProvider(state, provider) {
  return { ...state, digest: { ...sessionDigest(state), provider: String(provider ?? ''), overridden: true } };
}

export function editDigestInstruction(state, value) {
  return { ...state, digest: { ...sessionDigest(state), instruction: String(value ?? ''), overridden: true } };
}

// 子卡副标题：未覆盖「跟随预设：开 · deepseek / 关」；覆盖后「本次：…」
export function digestSubLabel(state) {
  const digest = sessionDigest(state);
  const summary = digest.on ? `开 · ${digest.provider || '默认'}` : '关';
  return digest.overridden ? `本次：${summary}` : `跟随预设：${summary}`;
}

// ——— 预设选择与可编辑标题（#36）：纯函数，state 只携带数据，DOM 同步由 popup.js 负责 ———

// 标题模板上下文只需 tab 信息 + 当前时间；content 在标题模板里无意义，不为此跑 extractor
export function buildTitleContext(tab, now = new Date()) {
  return buildContext({ title: tab?.title || '当前页面', sourceUrl: tab?.url || '', capturedAt: now });
}

export function currentPreset(state) {
  return state.presets.find((preset) => preset.id === state.presetId) ?? state.presets[0];
}

function renderCurrentTitle(state) {
  return renderTitle(currentPreset(state).titleTemplate, state.titleContext);
}

// 预设是顶层单位：自带保存目标、图片写入模式与 bodyTemplate（#29，#53 起 includeImages 泛化为
// 三态 imageMode，读取时迁移存量布尔）。选中预设即应用其参数；temporary 仅属于用户手动用选择器
// 覆盖的「仅本次」临时目标，预设自带目标不亮徽标
function applyPresetParams(state) {
  const preset = currentPreset(state);
  const pdfDrive = resolvePdfDrive(preset);
  return {
    ...state,
    destination: preset.destination ?? null,
    temporary: false,
    imageMode: resolveImageMode(preset),
    // PDF 存云盘（#65）：会话开关初值 = 预设默认；识别结果（state.pdf）随后由弹窗探测填入。
    // 会话目录（#66）初值同样取自预设 pdfDrive，手动 chip 选择只覆盖本次
    pdfOn: pdfDrive?.enabled === true,
    pdfFolder: pdfDrive ? createDriveFolder(pdfDrive) : null,
    pdf: state.pdf ?? null,
    // 自定义正文框预填所选预设的 bodyTemplate：切预设即应用新预设模板，
    // 清除上一次的一次性修改（与目标/图片的切预设语义一致）
    customBody: preset.bodyTemplate ?? '',
    // 临时 AI 摘要（#84）：切预设即恢复跟随新预设的 digest 配置，清除「本次」覆盖
    digest: sessionDigestFromPreset(preset),
  };
}

// ——— triggers 自动命中（#39）：规则语法与设置页校验一致（#35，决议 #32）———
// 普通字符串 = 前缀匹配；/pattern/ = 正则（仅支持 i 标志）。
// 优先级：前缀 > 正则；前缀取最长，等长按预设列表顺序；正则同为命中按预设列表顺序。
// 规则在设置页保存时已校验，这里对非法输入仅防御性跳过。

const REGEX_TRIGGER = /^\/(.+)\/([a-z]*)$/;

function parseRegexTrigger(trigger) {
  const match = REGEX_TRIGGER.exec(trigger);
  if (!match || !/^i*$/.test(match[2])) return null;
  try {
    return new RegExp(match[1], match[2]);
  } catch {
    return null;
  }
}

// 返回命中的预设 id，无命中返回 null
export function matchTrigger(presets, url) {
  if (!Array.isArray(presets) || typeof url !== 'string' || url === '') return null;
  let bestPrefix = null; // { presetId, length, index }
  let firstRegex = null; // { presetId, index }
  presets.forEach((preset, index) => {
    for (const trigger of preset.triggers ?? []) {
      if (typeof trigger !== 'string' || trigger === '') continue;
      const regex = parseRegexTrigger(trigger);
      if (regex) {
        if (!firstRegex && regex.test(url)) firstRegex = { presetId: preset.id, index };
      } else if (url.startsWith(trigger)) {
        if (!bestPrefix || trigger.length > bestPrefix.length || (trigger.length === bestPrefix.length && index < bestPrefix.index)) {
          bestPrefix = { presetId: preset.id, length: trigger.length, index };
        }
      }
    }
  });
  return (bestPrefix ?? firstRegex)?.presetId ?? null;
}

// 打开弹窗：先用当前页 URL 跑 trigger 匹配，命中则选中命中预设并亮 viaTrigger 提示；
// 无命中选默认预设。应用选中预设的目标/图片参数并按其 titleTemplate 渲染标题初值；
// 无预设时兜底为迁移生成的「默认」预设（正常路径 background 已迁移好，这里防御旧数据）
export function initPopupPresets({ presets, defaultPresetId } = {}, tab, now) {
  const list = Array.isArray(presets) && presets.length > 0 ? presets : [createDefaultPreset()];
  const matchedId = matchTrigger(list, tab?.url);
  const selected = (matchedId ? list.find((preset) => preset.id === matchedId) : null) ?? list.find((preset) => preset.id === defaultPresetId) ?? list[0];
  const state = applyPresetParams({ presets: list, presetId: selected.id, titleContext: buildTitleContext(tab, now) });
  // 两个折叠区与动作菜单是仅本次会话状态：#36 起弹窗一律不回写预设；customBody 由 applyPresetParams 预填
  return { ...state, title: renderCurrentTitle(state), settingsOpen: false, previewOpen: false, menuOpen: false, viaTrigger: Boolean(matchedId) };
}

// 手改检测：输入框值 ≠ 当前预设模板渲染值即视为手改；初始值与 ↺ 重置值都等于渲染值
export function isTitleEdited(state) {
  return state.title !== renderCurrentTitle(state);
}

// 切换预设：应用新预设的保存目标与图片写入模式，并清除之前的「仅本次」临时目标
// （三级语义：默认预设 → 选中预设 → 仅本次覆盖，换预设即从该预设重新起算）；
// 标题未手改时按新预设模板重渲，手改过则保留用户内容；
// 手动切换即脱离 trigger 命中态：提示消失，当次会话不再跑 trigger（重开弹窗重新匹配）
export function selectPreset(state, presetId) {
  if (presetId === state.presetId || !state.presets.some((preset) => preset.id === presetId)) return state;
  const next = applyPresetParams({ ...state, presetId, viaTrigger: false });
  if (!isTitleEdited(state)) next.title = renderCurrentTitle(next);
  return next;
}

// 手动「仅本次」目标覆盖：只影响当前预设会话，不回写预设
export function overrideDestination(state, destination) {
  return { ...state, destination: destination ?? null, temporary: true };
}

// ——— 保存为新预设（#40）———

function sameDestination(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// 「本次设置与所选预设不一致」的判定口径：弹窗可改的五项——保存目标（按值比较，
// 手动覆盖成相同目标不算修改）、图片写入模式、PDF 存云盘开关与目录（#66）、标题框、自定义正文框。
// 标题/正文的基线是「预填进框的值」而非模板原始串：标题基线 = 预设 titleTemplate 的
// 渲染结果（isTitleEdited 本就是这个比较），自定义正文基线 = 预设 bodyTemplate（预填值）。
export function isSessionModified(state) {
  const preset = currentPreset(state);
  return !sameDestination(state.destination, preset.destination ?? null)
    || state.imageMode !== resolveImageMode(preset)
    || isPdfSessionOnly(state)
    || isTitleEdited(state)
    || isCustomBodyEdited(state);
}

// 包含图片 checkbox 的仅本次改动：关掉 = 不保存；重新打开回到预设自身模式
// （预设本就是不保存时落到默认的预览优先）。写回 state 以便 diff 判定与保存时读取
export function setIncludeImages(state, includeImages) {
  if (includeImages === false) return { ...state, imageMode: 'off' };
  const presetMode = resolveImageMode(currentPreset(state));
  return { ...state, imageMode: presetMode === 'off' ? 'preview' : presetMode };
}

// 会话 PDF 开关 → 预设 pdfDrive 字段（#65）；目录取会话 chip 选择（#66），
// folderToken 为 null = 存云盘根目录（合法态）；关闭态归一为 null（与存量预设缺省同形）
function sessionPdfDrive(state) {
  return state.pdfOn
    ? { enabled: true, ...createDriveFolder({ folderToken: state.pdfFolder?.folderToken, folderName: state.pdfFolder?.folderName }) }
    : null;
}

// 构造并选中新预设：继承所选预设全部字段，用当前一次性设置覆盖五项——
// destination/imageMode/pdfDrive 用当前值；titleTemplate 在用户改过标题时固化为当前框内容
// （框里是渲染后的标题，固化成模板是用户自己的选择），没改则沿用源预设；
// bodyTemplate 恒取当前自定义正文框内容。triggers 拷贝继承（与设置页 duplicatePreset
// 的副本语义一致），重名允许（以 id 区分）。空名返回 null 由调用方拦截。
// 选中不走 selectPreset——新预设的目标就是当前目标，不能按「换预设清仅本次」清掉。
export function saveAsNewPreset(state, name) {
  const trimmed = String(name ?? '').trim();
  if (trimmed === '') return null;
  const source = currentPreset(state);
  const preset = {
    ...source,
    id: crypto.randomUUID(),
    name: trimmed,
    titleTemplate: isTitleEdited(state) ? state.title : source.titleTemplate,
    bodyTemplate: state.customBody,
    destination: state.destination,
    imageMode: state.imageMode,
    pdfDrive: sessionPdfDrive(state),
    triggers: [...(source.triggers ?? [])],
  };
  const next = { ...state, presets: [...state.presets, preset], presetId: preset.id, temporary: false, viaTrigger: false };
  // 标题模板继承自源预设，渲染值通常不变；仅在未手改时形式上重渲，语义与 selectPreset 一致
  if (!isTitleEdited(state)) next.title = renderCurrentTitle(next);
  return { state: next, preset };
}

// ——— 修改预设（#41）：把本次改动写回当前选中预设 ———

// 与 saveAsNewPreset 同一口径覆盖五项：destination/imageMode/pdfDrive 用当前值；
// titleTemplate 仅在标题手改过时固化为当前框内容；bodyTemplate 恒取当前自定义正文框。
// 区别在写回原位（id/name/triggers/action 等保留），不新建、不切换选中。
// 写回后 session 与预设一致（isSessionModified 变 false），按钮随之消失；
// temporary 清除——目标已归预设，不再挂「仅本次」徽标。未修改时返回 null 由调用方拦截。
export function updateCurrentPreset(state) {
  if (!isSessionModified(state)) return null;
  const source = currentPreset(state);
  const updated = {
    ...source,
    titleTemplate: isTitleEdited(state) ? state.title : source.titleTemplate,
    bodyTemplate: state.customBody,
    destination: state.destination,
    imageMode: state.imageMode,
    pdfDrive: sessionPdfDrive(state),
  };
  const presets = state.presets.map((preset) => (preset.id === source.id ? updated : preset));
  return { state: { ...state, presets, temporary: false }, preset: updated };
}

export function editTitle(state, value) {
  return { ...state, title: String(value ?? '') };
}

export function resetTitle(state) {
  return { ...state, title: renderCurrentTitle(state) };
}

// 语义 B：保存时把标题框当前字符串当作模板，用打开弹窗时的页面上下文再渲一次。
// 未手改时初始值已是渲染结果、不含 {{}}，二次渲染幂等；渲染出空白由 background 的
// sanitizeClipTitle 判空，回退 extractor 标题。不用 renderTitle（它会回退 ctx.title）。
export function finalTitle(state) {
  return renderTemplate(state.title, state.titleContext);
}

// ——— 本次设置折叠区 + 预览（#37；#40 起追加正文改为自定义正文模板）———

// 自定义正文（仅本次）：一次性正文模板，原样存放（支持换行与 {{content}} 占位）。
// 预填所选预设的 bodyTemplate（见 applyPresetParams），用户编辑只影响本次，不回写预设。
export function editCustomBody(state, value) {
  return { ...state, customBody: String(value ?? '') };
}

// 用户是否改过自定义正文（相对所选预设的 bodyTemplate）；用于展开预览时的滚动锚点
export function isCustomBodyEdited(state) {
  return state.customBody !== (currentPreset(state).bodyTemplate ?? '');
}

// 两个折叠区（settings / preview）状态独立，互不影响（#33 原型决议）
export function toggleSection(state, section) {
  const key = section === 'settings' ? 'settingsOpen' : section === 'preview' ? 'previewOpen' : null;
  if (!key) return state;
  return { ...state, [key]: !state[key] };
}

// 预览文本 = 最终保存正文 = 导出内容（composeClip 的 body）
export function previewBody(state, snapshot) {
  return composeClip(state, snapshot).body;
}

// ——— 导出动作（#38）：复制到剪贴板 / 保存为文件 ———

// 导出内容合成：与 background CLIP 同一规则——标题走语义 B 渲染 + sanitizeClipTitle
// 清洗、空白回退 extractor 标题；正文 = renderBody(自定义正文框内容)。
// 保存/复制/文件/预览四处共用此路径，保证内容一致。
// AI 摘要（#75）：预设开了 digest 开关时 {{digest}} 以字面量存活在预览/导出内容里
// （意为「此处将生成摘要」），保持 预览 === 保存内容 的不变量；最终替换发生在 bridge 侧
export function composeClip(state, snapshot) {
  const title = sanitizeClipTitle(finalTitle(state)) ?? (typeof snapshot?.title === 'string' ? snapshot.title : '');
  // {{digest}} 存活与否跟随会话开关（#84）：用户本次打开/关掉的覆盖与提交载荷同口径
  const digestEnabled = sessionDigest(state).on;
  return { title, body: renderBody(state.customBody, buildContext({ ...snapshot, title }, { digestEnabled })) };
}

// 弹窗 CLIP 消息携带的 AI 摘要字段（#75）：开关 + 指令原值（空串 = 回落全局）+ provider 名
// （空串 = 默认 provider）。#84 起取会话覆盖后的有效值：临时指令留空（含纯空白）则回落
// 预设级指令，预设也没有则空串——全局指令与内置默认的回落在 background 解析，弹窗不读全局设置。
// mode/docTitleTemplate（#98）不暴露会话覆盖，恒跟随当前预设（resolveDigest 已含缺省迁移）
export function clipDigest(state) {
  const digest = sessionDigest(state);
  const presetDigest = resolveDigest(currentPreset(state));
  const instruction = digest.instruction.trim() !== '' ? digest.instruction : presetDigest?.instruction ?? '';
  return {
    digestEnabled: digest.on,
    digestInstruction: instruction,
    digestProvider: digest.provider,
    digestMode: presetDigest?.mode ?? 'subdoc',
    digestDocTitleTemplate: presetDigest?.docTitleTemplate ?? DEFAULT_DIGEST_DOC_TITLE,
  };
}

// 导出文件名：渲染标题做文件系统安全清洗，空则回退 clip
export function clipFilename(title) {
  const base = sanitizeFilename(title);
  return `${base === '' ? 'clip' : base}.md`;
}

// ▾ 动作菜单开关（一次性执行菜单，不改变预设 action）
export function setMenuOpen(state, open) {
  return { ...state, menuOpen: Boolean(open) };
}

// 主按钮文字跟随当前预设默认动作；图标与设置页分段控件（#35）保持一致。
// 保存到飞书且本会话开了 PDF（且本页识别到主 PDF）时 CTA 变为「保存到飞书 + PDF」（#59 变体 A）
const PRIMARY_LABELS = {
  feishu: '⬇ 保存到飞书',
  clipboard: '⧉ 复制到剪贴板',
  file: '💾 保存为文件',
};

export function primaryLabel(action, session = null) {
  if ((action ?? 'feishu') === 'feishu' && session?.pdfOn && session?.pdf) return '⬇ 保存到飞书 + PDF';
  return PRIMARY_LABELS[action] ?? PRIMARY_LABELS.feishu;
}

// 预览滚动决策（#37 验收 bug 修复，#40 改自定义正文后调为三向锚点）：
// 预览是 180px 内滚区，自定义文本的位置由 {{content}} 占位符决定——
// 无占位符（整段追加在正文后）或占位符后有内容 → 滚到底才能看到自定义文本；
// 占位符在末尾（自定义文本全在正文前）→ 滚到顶；模板空白 → 无需滚动。
const CONTENT_PLACEHOLDER = /\{\{\s*content\s*\}\}/;

function customBodyAnchor(state) {
  const template = state.customBody;
  if (typeof template !== 'string' || template.trim() === '') return null;
  const match = CONTENT_PLACEHOLDER.exec(template);
  if (!match) return 'end';
  return template.slice(match.index + match[0].length).trim() === '' ? 'top' : 'end';
}

// 返回预览重渲后的滚动目标：'end' | 'top' | null（保持原位）。
// trigger 为 'body'（自定义正文输入）时滚到自定义文本所在端；'open'（展开预览）时
// 仅当用户改过自定义正文才滚动；其余重渲（标题/预设切换）保持滚动位置。
export function previewScrollTarget(trigger, state) {
  if (trigger === 'body') return customBodyAnchor(state);
  if (trigger === 'open') return isCustomBodyEdited(state) ? customBodyAnchor(state) : null;
  return null;
}
